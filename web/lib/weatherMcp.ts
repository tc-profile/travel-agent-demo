/**
 * Weather over MCP (Model Context Protocol).
 *
 * The weather tool lives in an MCP server rather than being hard-wired into the agent:
 *   - `createWeatherMcpServer()` defines the server (one tool: `get_weather`, backed by the real
 *     Open-Meteo lookup in `./tools`). `app/api/mcp/route.ts` publishes it over Streamable HTTP so
 *     any MCP client (Claude Desktop, MCP Inspector, another agent) can use it too.
 *   - `connectWeatherMcp()` is the client side the agent uses: it discovers the server's tools via
 *     `tools/list`, hands them to Claude as ordinary tool definitions, and routes Claude's tool
 *     calls back through `tools/call`.
 *
 * By default the client talks to an in-process copy of the server over MCP's in-memory transport
 * (same JSON-RPC protocol, no network hop — works identically on localhost and Vercel). Set
 * WEATHER_MCP_URL to connect to a remote MCP server over Streamable HTTP instead, e.g. this app's
 * own deployed `/api/mcp` endpoint, or any other server exposing a compatible `get_weather` tool.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { context, propagation } from "@opentelemetry/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { elapsedMs, logger, SpanKind, SpanStatusCode, withSpan } from "./observability";
import { getWeather } from "./tools";

const SERVER_INFO = { name: "aviana-weather", version: "1.0.0" };

/** Shape of a successful `get_weather` result — also what the chat widget renders as a weather card. */
export const weatherReportSchema = {
  location: z.string(),
  date: z.string(),
  source: z.string(),
  weather_code: z.number().nullable(),
  conditions: z.string(),
  temp_max_c: z.number().nullable(),
  temp_min_c: z.number().nullable(),
  precipitation_mm: z.number().nullable(),
};
export type WeatherReport = z.infer<z.ZodObject<typeof weatherReportSchema>>;

export function createWeatherMcpServer() {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "get_weather",
    {
      title: "Destination weather",
      description:
        "Get real weather for a destination on a given date, via Open-Meteo. Uses a live forecast if the date is within ~16 days; otherwise falls back to actual weather from the same date last year as an estimate.",
      inputSchema: {
        destination: z.string().describe("Destination city"),
        date: z.string().describe("Date, YYYY-MM-DD"),
      },
      outputSchema: weatherReportSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ destination, date }) =>
      // Server-side span: nests under the agent's execute_tool span in-process, and under the
      // /api/mcp request span (which continues the caller's traceparent) over HTTP.
      withSpan(
        "tools/call get_weather",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "mcp.method.name": "tools/call",
            "mcp.server.name": SERVER_INFO.name,
            "gen_ai.tool.name": "get_weather",
          },
        },
        async (span) => {
          const start = performance.now();
          const intent = { tool: "get_weather", args: { destination, date } };
          const result = await getWeather(destination, date);
          if ("error" in result) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
            logger.warn("mcp.tool.failed", {
              intent,
              outcome: "error",
              error_message: result.error,
              duration_ms: elapsedMs(start),
            });
            return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }] };
          }
          const source = result.source === "live forecast" ? "forecast" : "last_year_estimate";
          span.setAttributes({ "app.outcome": "ok", "app.weather.source": source });
          logger.info("mcp.tool.completed", {
            intent,
            outcome: "ok",
            location: result.location,
            conditions: result.conditions,
            weather_source: source,
            duration_ms: elapsedMs(start),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
      )
  );

  return server;
}

export type WeatherMcpSession = {
  transport: "in_memory" | "streamable_http";
  /** MCP tools translated into Anthropic tool definitions. */
  tools: Anthropic.Tool[];
  has(name: string): boolean;
  call(name: string, input: Record<string, unknown>): Promise<McpToolOutcome>;
  close(): Promise<void>;
};

export type McpToolOutcome = {
  /** What gets sent back to Claude as the tool_result content. */
  text: string;
  isError: boolean;
  /** Present when the tool returned a weather report — surfaced to the UI as a card. */
  weather?: WeatherReport;
};

/**
 * fetch for the HTTP transport that injects the active W3C trace context (`traceparent`), so the
 * remote MCP server's spans join the caller's trace — distributed tracing across the MCP hop.
 */
const tracePropagatingFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  propagation.inject(context.active(), headers, { set: (carrier, key, value) => carrier.set(key, value) });
  return fetch(input, { ...init, headers });
};

export async function connectWeatherMcp(): Promise<WeatherMcpSession> {
  const remoteUrl = process.env.WEATHER_MCP_URL;
  const transport = remoteUrl ? "streamable_http" : "in_memory";
  return withSpan(
    "mcp.connect aviana-weather",
    { kind: SpanKind.CLIENT, attributes: { "mcp.transport": transport, "mcp.server.name": SERVER_INFO.name } },
    async (span) => {
      const start = performance.now();
      const session = await openSession(remoteUrl, transport);
      span.setAttribute("mcp.tools.count", session.tools.length);
      logger.info("mcp.connect.completed", {
        outcome: "ok",
        transport,
        server_url: remoteUrl ? new URL(remoteUrl).origin + new URL(remoteUrl).pathname : undefined,
        tools: session.tools.map((t) => t.name),
        duration_ms: elapsedMs(start),
      });
      return session;
    }
  );
}

async function openSession(
  remoteUrl: string | undefined,
  transport: WeatherMcpSession["transport"]
): Promise<WeatherMcpSession> {
  const client = new Client({ name: "aviana-trip-planner", version: "1.0.0" });

  let closeServer: (() => Promise<void>) | undefined;
  if (remoteUrl) {
    await client.connect(new StreamableHTTPClientTransport(new URL(remoteUrl), { fetch: tracePropagatingFetch }));
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWeatherMcpServer();
    await server.connect(serverTransport);
    closeServer = () => server.close();
    await client.connect(clientTransport);
  }

  const { tools: mcpTools } = await client.listTools();
  // Sorted so the tool list (and therefore the prompt-cache prefix) is stable across requests.
  const tools: Anthropic.Tool[] = [...mcpTools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      // MCP servers may tag schemas with a JSON-Schema `$schema` draft URI; Claude doesn't need it.
      const { $schema: _draft, ...inputSchema } = t.inputSchema as Record<string, unknown>;
      void _draft;
      return {
        name: t.name,
        description: t.description ?? "",
        input_schema: inputSchema as Anthropic.Tool.InputSchema,
      };
    });
  const names = new Set(tools.map((t) => t.name));

  return {
    transport,
    tools,
    has: (name) => names.has(name),
    async call(name, input) {
      const result = await client.callTool({ name, arguments: input });
      const content = Array.isArray(result.content) ? result.content : [];
      const text =
        content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n") || JSON.stringify(result.structuredContent ?? {});
      const isError = result.isError === true;
      const parsed = z.object(weatherReportSchema).safeParse(result.structuredContent);
      return { text, isError, weather: !isError && parsed.success ? parsed.data : undefined };
    },
    async close() {
      await client.close();
      await closeServer?.();
    },
  };
}
