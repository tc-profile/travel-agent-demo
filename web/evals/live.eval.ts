/**
 * Live regression eval — runs the golden cases in ./cases.ts against the REAL multi-agent system
 * (real Claude API, real Open-Meteo, knowledge base if configured). Opt-in and billed:
 *
 *   npm run eval                      # needs ANTHROPIC_API_KEY (read from .env.local or the shell)
 *   EVAL_CASES=greeting,policy-question npm run eval     # subset
 *   EVAL_UPDATE_BASELINE=1 npm run eval                  # record evals/baseline.json
 *
 * Every case also checks universal invariants: non-empty reply, no blocking output-guardrail
 * finding, text-only shared history, per-case cost under EVAL_MAX_COST_USD (default $0.50).
 * A report is written to evals/results/<timestamp>.json; with a baseline present, cases that passed
 * in the baseline and fail now are listed as regressions.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runAgentTurn, type AgentTurnResult } from "@/lib/agent";
import { checkOutput } from "@/lib/agents/guardrails";
import { blockTypes } from "../tests/helpers/fakeClaude";
import { logs, startLogCapture } from "../tests/helpers/logs";
import { CASES, type EvalCase } from "./cases";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_COST = Number(process.env.EVAL_MAX_COST_USD || "0.5");
const ONLY = process.env.EVAL_CASES?.split(",").map((s) => s.trim()).filter(Boolean);
const dir = fileURLToPath(new URL(".", import.meta.url));

type CaseReport = {
  id: string;
  passed: boolean;
  failures: string[];
  outcome?: string;
  intent?: string;
  agents?: AgentTurnResult["meta"]["agents"];
  review?: string;
  tools?: string[];
  cost_usd?: number;
  duration_ms: number;
  reply_preview?: string;
};
const reports: CaseReport[] = [];

function check(c: EvalCase, r: AgentTurnResult, tools: string[], cost: number): string[] {
  const f: string[] = [];
  const e = c.expect;
  const names = r.meta.agents.map((a) => a.name);
  if (e.outcome && !e.outcome.includes(r.outcome)) f.push(`outcome ${r.outcome} ∉ ${e.outcome.join("|")}`);
  if (e.intent && !e.intent.includes(r.intent.primary)) f.push(`intent ${r.intent.primary} ∉ ${e.intent.join("|")}`);
  for (const a of e.agentsInclude ?? []) if (!names.includes(a)) f.push(`agent ${a} missing (got ${names.join(", ")})`);
  for (const a of e.agentsExclude ?? []) if (names.includes(a)) f.push(`agent ${a} should not run`);
  for (const [agent, model] of Object.entries(e.modelFor ?? {})) {
    const got = r.meta.agents.find((a) => a.name === agent)?.model;
    if (got !== model) f.push(`${agent} model ${got ?? "none"} ≠ ${model}`);
  }
  for (const t of e.toolsInclude ?? []) if (!tools.includes(t)) f.push(`tool ${t} not called (called ${tools.join(", ") || "none"})`);
  for (const t of e.toolsExclude ?? []) if (tools.includes(t)) f.push(`tool ${t} should not be called`);
  if (e.minWeatherCards !== undefined && r.weather.length < e.minWeatherCards) f.push(`weather cards ${r.weather.length} < ${e.minWeatherCards}`);
  for (const re of e.replyMatches ?? []) if (!re.test(r.reply)) f.push(`reply should match ${re}`);
  for (const re of e.replyNotMatches ?? []) if (re.test(r.reply)) f.push(`reply should not match ${re}`);
  if (e.review && !e.review.includes(r.meta.review)) f.push(`review ${r.meta.review} ∉ ${e.review.join("|")}`);

  // Universal invariants.
  if (!r.reply.trim()) f.push("empty reply");
  const blocking = checkOutput(r.reply, { userMessage: c.message, evidence: "" }).filter((x) => x.severity === "block");
  if (blocking.length) f.push(`blocking guardrail finding in final reply: ${blocking.map((x) => x.rule).join(", ")}`);
  const types = blockTypes(r.messages);
  for (const t of types) if (!["string", "text", "compaction"].includes(t)) f.push(`non-text block '${t}' in shared history`);
  if (cost > MAX_COST) f.push(`cost $${cost.toFixed(4)} > $${MAX_COST}`);
  return f;
}

describe.skipIf(!API_KEY)("live regression eval", () => {
  const client = new Anthropic({ apiKey: API_KEY });
  beforeEach(() => startLogCapture());

  for (const c of CASES.filter((x) => !ONLY || ONLY.includes(x.id))) {
    it(`${c.id}: ${c.description}`, async () => {
      const start = Date.now();
      const report: CaseReport = { id: c.id, passed: false, failures: [], duration_ms: 0 };
      try {
        const r = await runAgentTurn(client, c.history ?? [], { userMessage: c.message, conversationId: `eval-${c.id}` });
        const tools = [...new Set(logs("tool.call.completed").map((l) => (l.intent as { tool: string }).tool))];
        const cost = Number((logs("agent.turn.completed")[0]?.cost as { est_cost_usd?: number })?.est_cost_usd ?? 0);
        report.failures = check(c, r, tools, cost);
        Object.assign(report, {
          outcome: r.outcome,
          intent: r.intent.primary,
          agents: r.meta.agents,
          review: r.meta.review,
          tools,
          cost_usd: cost,
          reply_preview: r.reply.slice(0, 300),
        });
      } catch (err) {
        report.failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      report.duration_ms = Date.now() - start;
      report.passed = report.failures.length === 0;
      reports.push(report);
      expect(report.failures).toEqual([]);
    });
  }

  afterAll(() => {
    if (!reports.length) return;
    const baselinePath = `${dir}baseline.json`;
    const baseline: { cases: CaseReport[] } | null = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
    const regressions = baseline
      ? reports.filter((r) => !r.passed && baseline.cases.find((b) => b.id === r.id)?.passed).map((r) => r.id)
      : [];
    const summary = {
      ran_at: new Date().toISOString(),
      passed: reports.filter((r) => r.passed).length,
      total: reports.length,
      pass_rate: reports.filter((r) => r.passed).length / reports.length,
      total_cost_usd: Math.round(reports.reduce((n, r) => n + (r.cost_usd ?? 0), 0) * 1e4) / 1e4,
      regressions_vs_baseline: regressions,
      cases: reports,
    };
    mkdirSync(`${dir}results`, { recursive: true });
    const out = `${dir}results/${summary.ran_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(out, JSON.stringify(summary, null, 2));
    if (process.env.EVAL_UPDATE_BASELINE === "1") writeFileSync(baselinePath, JSON.stringify(summary, null, 2));
    process.stdout.write(
      `\nLive eval: ${summary.passed}/${summary.total} passed · est. cost $${summary.total_cost_usd}` +
        (baseline ? ` · regressions vs baseline: ${regressions.join(", ") || "none"}` : " · no baseline") +
        `\nReport: ${out}\n`
    );
  });
});
