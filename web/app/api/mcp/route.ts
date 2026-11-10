import { trace } from "@opentelemetry/api";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { elapsedMs, logger } from "@/lib/observability";
import { createWeatherMcpServer } from "@/lib/weatherMcp";

/**
 * Public MCP endpoint (Streamable HTTP, stateless) exposing the weather server's `get_weather`
 * tool. Point any MCP client at `<site>/api/mcp`, or set WEATHER_MCP_URL to it so the chat agent
 * connects over HTTP instead of in-process. Like /api/chat this is unauthenticated; it only wraps
 * the free Open-Meteo API, so there's no paid spend behind it.
 *
 * Tracing: Next.js continues the caller's `traceparent` for this request's root span, so the
 * tool's server-side span joins the calling agent's trace.
 */
async function handle(request: Request) {
  const start = performance.now();
  trace.getActiveSpan()?.setAttributes({ "app.route": "/api/mcp", "mcp.transport": "streamable_http" });

  // Peek at the JSON-RPC method for the log line without consuming the body the transport reads.
  let rpcMethod: string | undefined;
  if (request.method === "POST") {
    const peek = await request.clone().json().catch(() => null);
    rpcMethod = Array.isArray(peek) ? peek.map((m) => m?.method).join(",") : peek?.method;
  }

  // Stateless mode: a fresh server + transport per request (no session affinity on serverless).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createWeatherMcpServer();
  await server.connect(transport);
  const response = await transport.handleRequest(request);

  logger[response.ok ? "info" : "warn"]("mcp.http.request.completed", {
    outcome: response.ok ? "ok" : "error",
    http_method: request.method,
    rpc_method: rpcMethod,
    status: response.status,
    duration_ms: elapsedMs(start),
  });
  return response;
}

export { handle as GET, handle as POST, handle as DELETE };
