import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  callClaude,
  echoableContent,
  escalate,
  MODELS,
  modelLabel,
  parseJson,
  responseText,
  routeModel,
  UsageLedger,
  type AgentName,
  type Complexity,
} from "@/lib/agents/models";
import { fakeClaude, json, message, text } from "../helpers/fakeClaude";
import { logs } from "../helpers/logs";

describe("model tiers & routing table", () => {
  it("defaults to Haiku 5.5 / Sonnet 5.5 / Opus 5.5", () => {
    expect(MODELS).toEqual({ fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" });
  });

  it("matches the golden routing table (regression guard for cost/quality routing)", () => {
    const agents: AgentName[] = ["trip_planner", "policy_expert", "weather_specialist", "concierge"];
    const complexities: Complexity[] = ["simple", "standard", "complex"];
    const table = Object.fromEntries(
      agents.map((a) => [a, Object.fromEntries(complexities.map((c) => [c, `${routeModel(a, c).model}/${routeModel(a, c).effort}`]))])
    );
    expect(table).toEqual({
      trip_planner: { simple: "claude-sonnet-5-5/low", standard: "claude-sonnet-5-5/medium", complex: "claude-opus-5-5/medium" },
      policy_expert: { simple: "claude-haiku-5-5/medium", standard: "claude-sonnet-5-5/low", complex: "claude-sonnet-5-5/medium" },
      weather_specialist: { simple: "claude-haiku-5-5/low", standard: "claude-haiku-5-5/medium", complex: "claude-sonnet-5-5/low" },
      concierge: { simple: "claude-haiku-5-5/low", standard: "claude-haiku-5-5/low", complex: "claude-haiku-5-5/medium" },
    });
  });

  it("escalates one tier at a time and stops at deep", () => {
    expect(escalate("fast")).toBe("balanced");
    expect(escalate("balanced")).toBe("deep");
    expect(escalate("deep")).toBeNull();
  });

  it("MODEL_* env vars override tiers; ANTHROPIC_MODEL does not", async () => {
    vi.stubEnv("MODEL_DEEP", "claude-fable-5-1");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5");
    vi.resetModules();
    const mod = await import("@/lib/agents/models");
    expect(mod.MODELS).toEqual({ fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-fable-5-1" });
  });

  it("labels models for the UI", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelLabel("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelLabel("custom-model")).toBe("custom-model");
  });
});

describe("response helpers", () => {
  const p = { model: "claude-haiku-5-5" } as never;

  it("responseText joins text blocks only", () => {
    const r = message(p, "end_turn", [{ type: "thinking", thinking: "", signature: "s" }, text("a"), { type: "compaction", content: "S" }, text("b")]);
    expect(responseText(r)).toBe("ab");
  });

  it("parseJson returns null on refusal, truncation or invalid JSON", () => {
    expect(parseJson(message(p, "end_turn", [json({ ok: 1 })]))).toEqual({ ok: 1 });
    expect(parseJson(message(p, "refusal", [json({ ok: 1 })]))).toBeNull();
    expect(parseJson(message(p, "max_tokens", [text('{"ok":')]))).toBeNull();
    expect(parseJson(message(p, "end_turn", [text("not json")]))).toBeNull();
  });

  it("echoableContent drops declined-model internals before the last fallback marker", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "tool_use", id: "t", name: "x", input: {} },
      text("partial"),
      { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      { type: "thinking", thinking: "", signature: "y" },
      text("final"),
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(echoableContent(content).map((b) => b.type)).toEqual(["text", "fallback", "thinking", "text"]);
    const noFallback = [text("x")] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(echoableContent(noFallback)).toBe(noFallback);
  });
});

describe("UsageLedger", () => {
  it("prices calls per model, including compaction iterations and cache tokens", () => {
    const ledger = new UsageLedger();
    const p = { model: "claude-sonnet-5-5" } as never;
    ledger.record(
      "claude-sonnet-5-5",
      message(p, "end_turn", [], {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 500_000, output_tokens: 0 }] as never,
      })
    );
    ledger.record("claude-haiku-5-5", message(p, "end_turn", [], { input_tokens: 1_000_000, output_tokens: 0 }));
    const summary = ledger.summary();
    // Sonnet: 1.5M in × $2 + 0.1M out × $10 + 1M cache read × $0.20 = $4.20; Haiku: 1M × $0.10 = $0.10
    expect(summary.models["claude-sonnet-5-5"].est_cost_usd).toBeCloseTo(4.2, 6);
    expect(summary.models["claude-haiku-5-5"].est_cost_usd).toBeCloseTo(0.1, 6);
    expect(summary.est_cost_usd).toBeCloseTo(4.3, 6);
    expect(summary.models["claude-sonnet-5-5"]).toMatchObject({ calls: 1, compaction_input_tokens: 500_000 });
  });

  it("marks cost incomplete for unpriced models", () => {
    const ledger = new UsageLedger();
    ledger.record("mystery-model", message({ model: "mystery-model" } as never, "end_turn", []));
    expect(ledger.summary()).toMatchObject({ cost_incomplete: true, models: { "mystery-model": { est_cost_usd: null } } });
  });
});

describe("callClaude request shape", () => {
  const base = { agent: "test", effort: "low" as const, system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

  it("adds compaction, refusal fallback, caching and effort for Sonnet/Opus", async () => {
    const { client, calls } = fakeClaude({ synthesizer: (p) => message(p, "end_turn", [text("ok")]) });
    await callClaude({ ...base, client, tier: "balanced", compaction: true, ledger: new UsageLedger() });
    const params = calls[0].params;
    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
      betas: ["compact-2026-01-12", "server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
      cache_control: { type: "ephemeral" },
      output_config: { effort: "low" },
      context_management: { edits: [expect.objectContaining({ type: "compact_20260112" })] },
    });
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("thinking"); // adaptive by default on these models
    expect(params).not.toHaveProperty("tool_choice"); // forced tool_choice 400s on Opus/Sonnet 5.5
  });

  it("sends no fallback for Haiku and no betas when nothing needs them; adds structured output", async () => {
    const { client, calls } = fakeClaude({ router: (p) => message(p, "end_turn", [json({})]) });
    const schema = { type: "object", properties: { tasks: { type: "array" } } };
    await callClaude({ ...base, client, tier: "fast", outputSchema: schema, ledger: new UsageLedger() });
    const params = calls[0].params;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("context_management");
    expect(params.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema } });
  });

  it("REFUSAL_FALLBACKS=off disables fallbacks", async () => {
    vi.stubEnv("REFUSAL_FALLBACKS", "off");
    vi.resetModules();
    const mod = await import("@/lib/agents/models");
    const { client, calls } = fakeClaude({ synthesizer: (p) => message(p, "end_turn", [text("ok")]) });
    await mod.callClaude({ ...base, client, tier: "deep", ledger: new mod.UsageLedger() });
    expect(calls[0].params).not.toHaveProperty("fallbacks");
  });

  it("logs completion, refusals (with category) and failures", async () => {
    const { client } = fakeClaude({
      synthesizer: (p, { call }) => {
        if (call === 1) return message(p, "end_turn", [text("ok")]);
        if (call === 2) return { ...message(p, "refusal", []), stop_details: { type: "refusal", category: "cyber", explanation: null } };
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    });
    const ledger = new UsageLedger();
    await callClaude({ ...base, client, tier: "balanced", ledger });
    await callClaude({ ...base, client, tier: "balanced", ledger });
    await expect(callClaude({ ...base, client, tier: "balanced", ledger })).rejects.toThrow("boom");
    expect(logs("llm.call.completed")).toHaveLength(2);
    expect(logs("llm.call.completed")[0]).toMatchObject({ agent: "test", tier: "balanced", requested_model: "claude-sonnet-5-5", stop_reason: "end_turn" });
    expect(logs("llm.call.refused")[0]).toMatchObject({ category: "cyber", fallback_attempted: true });
    expect(logs("llm.call.failed")[0]).toMatchObject({ error: { message: "boom", status: 500 } });
  });
});
