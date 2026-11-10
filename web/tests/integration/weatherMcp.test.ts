import { describe, expect, it } from "vitest";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { connectWeatherMcp } from "@/lib/weatherMcp";
import { logs } from "../helpers/logs";
import { stubOpenMeteo } from "../helpers/openMeteo";

describe("weather MCP server (in-memory transport)", () => {
  it("advertises get_weather with a Claude-ready schema", async () => {
    const mcp = await connectWeatherMcp();
    try {
      expect(mcp.transport).toBe("in_memory");
      expect(mcp.tools).toEqual([
        {
          name: "get_weather",
          description: expect.stringContaining("Open-Meteo"),
          input_schema: {
            type: "object",
            properties: {
              destination: { type: "string", description: "Destination city" },
              date: { type: "string", description: "Date, YYYY-MM-DD" },
            },
            required: ["destination", "date"],
          },
        },
      ]);
      expect(mcp.has("get_weather")).toBe(true);
      expect(mcp.has("search_flights")).toBe(false);
      expect(logs("mcp.connect.completed")[0]).toMatchObject({ outcome: "ok", transport: "in_memory", tools: ["get_weather"] });
    } finally {
      await mcp.close();
    }
  });

  it("returns structured weather for the UI card, and errors as isError", async () => {
    stubOpenMeteo({ weatherCode: 3 });
    const mcp = await connectWeatherMcp();
    try {
      const ok = await mcp.call("get_weather", { destination: "Lisbon", date: "2026-11-14" });
      expect(ok.isError).toBe(false);
      expect(ok.weather).toMatchObject({ location: "Lisbon, Portugal", conditions: "Overcast", source: "live forecast" });
      expect(JSON.parse(ok.text)).toEqual(ok.weather);

      const bad = await mcp.call("get_weather", { destination: "Atlantis", date: "2026-11-14" });
      expect(bad).toMatchObject({ isError: true, weather: undefined });
      expect(bad.text).toContain("Could not find location");

      expect(logs("mcp.tool.completed")[0]).toMatchObject({ outcome: "ok", intent: { tool: "get_weather", args: { destination: "Lisbon" } } });
      expect(logs("mcp.tool.failed")[0]).toMatchObject({ outcome: "error" });
    } finally {
      await mcp.close();
    }
  });
});

describe("/api/mcp (Streamable HTTP, stateless)", () => {
  const rpc = (body: unknown) =>
    mcpPost(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify(body),
      })
    );

  it("speaks JSON-RPC: initialize, tools/list, tools/call", async () => {
    stubOpenMeteo({ weatherCode: 0 });
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo).toEqual({ name: "aviana-weather", version: "1.0.0" });

    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["get_weather"]);
    expect(list.result.tools[0].outputSchema.properties).toHaveProperty("conditions");

    const call = await (
      await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_weather", arguments: { destination: "Tokyo", date: "2026-11-12" } } })
    ).json();
    expect(call.result.structuredContent).toMatchObject({ location: "Tokyo, Japan", conditions: "Clear sky" });

    expect(logs("mcp.http.request.completed").map((l) => l.rpc_method)).toEqual(["initialize", "tools/list", "tools/call"]);
  });

  it("rejects clients that don't accept the Streamable HTTP content types", async () => {
    const res = await mcpPost(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/html" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(res.status).toBe(406);
  });
});
