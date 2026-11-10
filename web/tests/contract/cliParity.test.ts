/**
 * Contract test: the Python CLI (../travel_agent.py) and the web agents must expose the same tool
 * contracts (names, descriptions, input schemas) and the same weather-condition labels — the repo's
 * CLAUDE.md files require keeping them in sync. Skipped if python3 (with `requests`) isn't available.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgentTurn } from "@/lib/agent";
import { getWeather } from "@/lib/tools";
import { fakeClaude, grade, reply, route } from "../helpers/fakeClaude";
import { stubOpenMeteo } from "../helpers/openMeteo";

type Tool = { name: string; description: string; input_schema: { type: string; properties: Record<string, unknown>; required: string[] } };

const script = fileURLToPath(new URL("./dump_cli_contract.py", import.meta.url));

function dumpCli(): { tools: Tool[]; wmo: Record<string, string>; dispatch: string[] } | null {
  try {
    return JSON.parse(execFileSync("python3", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return null;
  }
}

const cli = dumpCli();

describe.skipIf(!cli)("CLI ↔ web contract", () => {
  let webTools: Tool[] = [];

  beforeAll(async () => {
    // Capture exactly what the web agents send to Claude (local tools + MCP-discovered get_weather).
    const { client, calls } = fakeClaude({
      router: route({ tasks: [{ agent: "trip_planner", brief: "a" }, { agent: "policy_expert", brief: "b" }] }),
      trip_planner: reply("t"),
      policy_expert: reply("p"),
      synthesizer: reply("m"),
      evaluator: grade("pass"),
    });
    await runAgentTurn(client, [], { userMessage: "x" });
    const byName = new Map<string, Tool>();
    for (const c of calls) for (const t of (c.params.tools ?? []) as Tool[]) byName.set(t.name, t);
    webTools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  it("exposes the same set of tools, all registered in the CLI's dispatch table", () => {
    const cliNames = cli!.tools.map((t) => t.name).sort();
    expect(webTools.map((t) => t.name)).toEqual(cliNames);
    expect(cli!.dispatch).toEqual(cliNames);
  });

  it("uses identical descriptions and input schemas", () => {
    const normalize = (t: Tool) => ({
      name: t.name,
      description: t.description,
      properties: t.input_schema.properties,
      required: [...t.input_schema.required].sort(),
    });
    const cliByName = Object.fromEntries(cli!.tools.map((t) => [t.name, normalize(t)]));
    for (const tool of webTools) {
      expect(normalize(tool), tool.name).toEqual(cliByName[tool.name]);
    }
  });

  it("maps every WMO weather code to the same condition label", async () => {
    for (let code = 0; code <= 99; code++) {
      stubOpenMeteo({ weatherCode: code });
      const result = (await getWeather("Lisbon", "2026-11-14")) as { conditions: string };
      expect(result.conditions, `WMO code ${code}`).toBe(cli!.wmo[String(code)] ?? "Unknown");
    }
  });
});
