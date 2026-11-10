import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createWeatherMcpServer } from "@/lib/weatherMcp";

/**
 * Public MCP endpoint (Streamable HTTP, stateless) exposing the weather server's `get_weather`
 * tool. Point any MCP client at `<site>/api/mcp`, or set WEATHER_MCP_URL to it so the chat agent
 * connects over HTTP instead of in-process. Like /api/chat this is unauthenticated; it only wraps
 * the free Open-Meteo API, so there's no paid spend behind it.
 */
async function handle(request: Request) {
  // Stateless mode: a fresh server + transport per request (no session affinity on serverless).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createWeatherMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export { handle as GET, handle as POST, handle as DELETE };
