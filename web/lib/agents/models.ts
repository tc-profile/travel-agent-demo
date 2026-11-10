/**
 * Model tiers, strategic routing table, and the single wrapper every agent uses to call Claude.
 *
 * Three tiers, picked per task by code (not by a model) so routing is cheap, auditable and testable:
 *   fast     → Claude Haiku 5.5   triage, small talk, quick lookups
 *   balanced → Claude Sonnet 5.5  most planning and policy answers, synthesis, evaluation
 *   deep     → Claude Opus 5.5    complex multi-constraint itineraries, judging deep-tier output
 *
 * `callClaude` centralizes what every request needs: effort, structured output, server-side
 * compaction (for agents that see the conversation), prompt caching, refusal fallbacks, OTel spans,
 * JSON logs, and a per-turn cost ledger.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { COMPACTION_BETA, compactionConfig } from "../compaction";
import { elapsedMs, logger, SpanKind, withSpan } from "../observability";

export type Tier = "fast" | "balanced" | "deep";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const MODELS: Record<Tier, string> = {
  fast: process.env.MODEL_FAST || "claude-haiku-5-5",
  // ANTHROPIC_MODEL (the CLI's setting) is intentionally not read here, so an old single-model
  // deployment setting can't silently pin the routed tiers.
  balanced: process.env.MODEL_BALANCED || "claude-sonnet-5-5",
  deep: process.env.MODEL_DEEP || "claude-opus-5-5",
};

const TIER_ORDER: Tier[] = ["fast", "balanced", "deep"];

/** Next tier up, used when self-evaluation says a draft needs a stronger model. */
export function escalate(tier: Tier): Tier | null {
  return TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] ?? null;
}

export function tierRank(tier: Tier) {
  return TIER_ORDER.indexOf(tier);
}

// ---------------------------------------------------------------------------
// Strategic routing table: (agent, complexity) → tier + effort
// ---------------------------------------------------------------------------

export type AgentName = "trip_planner" | "policy_expert" | "weather_specialist" | "concierge";
export type Complexity = "simple" | "standard" | "complex";

const ROUTING_TABLE: Record<AgentName, Record<Complexity, { tier: Tier; effort: Effort }>> = {
  // Itineraries juggle dates, budgets and several tools; complex ones (multi-city, many travelers,
  // tight constraints) earn the deep tier.
  trip_planner: {
    simple: { tier: "balanced", effort: "low" },
    standard: { tier: "balanced", effort: "medium" },
    complex: { tier: "deep", effort: "medium" },
  },
  // Policy answers must match the retrieved documents exactly; only trivial lookups go fast.
  policy_expert: {
    simple: { tier: "fast", effort: "medium" },
    standard: { tier: "balanced", effort: "low" },
    complex: { tier: "balanced", effort: "medium" },
  },
  weather_specialist: {
    simple: { tier: "fast", effort: "low" },
    standard: { tier: "fast", effort: "medium" },
    complex: { tier: "balanced", effort: "low" },
  },
  concierge: {
    simple: { tier: "fast", effort: "low" },
    standard: { tier: "fast", effort: "low" },
    complex: { tier: "fast", effort: "medium" },
  },
};

export function routeModel(agent: AgentName, complexity: Complexity) {
  const choice = ROUTING_TABLE[agent][complexity];
  return { ...choice, model: MODELS[choice.tier] };
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/** USD per million tokens (list prices, used only for logged estimates). */
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};

type ModelUsage = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  compaction_input_tokens: number;
  compaction_output_tokens: number;
};

export class UsageLedger {
  private byModel = new Map<string, ModelUsage>();

  record(model: string, response: Anthropic.Beta.BetaMessage) {
    const u = this.byModel.get(model) ?? {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      compaction_input_tokens: 0,
      compaction_output_tokens: 0,
    };
    u.calls += 1;
    u.input_tokens += response.usage.input_tokens;
    u.output_tokens += response.usage.output_tokens;
    u.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
    u.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
    // Compaction cost is reported only in usage.iterations, not the top-level usage.
    for (const it of response.usage.iterations ?? []) {
      if (it.type === "compaction") {
        u.compaction_input_tokens += it.input_tokens;
        u.compaction_output_tokens += it.output_tokens;
      }
    }
    this.byModel.set(model, u);
  }

  static costOf(model: string, u: ModelUsage) {
    const p = PRICING[model];
    if (!p) return null;
    const input = u.input_tokens + u.compaction_input_tokens;
    const output = u.output_tokens + u.compaction_output_tokens;
    return (
      (input * p.input + output * p.output + u.cache_read_input_tokens * p.cacheRead + u.cache_creation_input_tokens * p.input * 1.25) /
      1_000_000
    );
  }

  summary() {
    let total = 0;
    let unknownPricing = false;
    const models: Record<string, ModelUsage & { est_cost_usd: number | null }> = {};
    for (const [model, u] of this.byModel) {
      const cost = UsageLedger.costOf(model, u);
      if (cost === null) unknownPricing = true;
      else total += cost;
      models[model] = { ...u, est_cost_usd: cost === null ? null : round6(cost) };
    }
    return { models, est_cost_usd: round6(total), ...(unknownPricing ? { cost_incomplete: true } : {}) };
  }
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Refusal fallbacks
// ---------------------------------------------------------------------------

/**
 * Server-side refusal fallback (beta, array form — the form this SDK version types). If a request is
 * declined by a safety classifier, the API re-runs it on the fallback model inside the same call.
 * Supported targets are `claude-opus-4-8` and `claude-opus-5`. Haiku has no server-side fallback.
 * Disable with REFUSAL_FALLBACKS=off.
 */
const FALLBACK_BETA = "server-side-fallback-2026-06-01";
const FALLBACK_MODEL = process.env.REFUSAL_FALLBACK_MODEL || "claude-opus-4-8";
const FALLBACKS_ENABLED = (process.env.REFUSAL_FALLBACKS ?? "on").toLowerCase() !== "off";
const FALLBACK_CAPABLE = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

function fallbackFor(model: string) {
  return FALLBACKS_ENABLED && FALLBACK_CAPABLE.has(model) && model !== FALLBACK_MODEL ? FALLBACK_MODEL : null;
}

/**
 * Content safe to echo back on the next request. After a fallback, thinking / tool_use / unknown
 * internal blocks that precede the final `fallback` marker came from the declined model and must be
 * omitted; text blocks and everything after the marker are kept.
 */
export function echoableContent(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFallback < 0) return content as Anthropic.Beta.BetaContentBlockParam[];
  const keepBefore = new Set(["text", "compaction"]);
  return content.filter((b, i) => i >= lastFallback || keepBefore.has(b.type)) as Anthropic.Beta.BetaContentBlockParam[];
}

// ---------------------------------------------------------------------------
// The one Claude call wrapper
// ---------------------------------------------------------------------------

export type CallOptions = {
  client: Anthropic;
  agent: string;
  tier: Tier;
  effort: Effort;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  /** JSON schema for structured output (router, evaluator). */
  outputSchema?: Record<string, unknown>;
  /** Enable server-side compaction — for agents whose input includes the customer conversation. */
  compaction?: boolean;
  ledger: UsageLedger;
  round?: number;
};

export async function callClaude(opts: CallOptions): Promise<Anthropic.Beta.BetaMessage> {
  const model = MODELS[opts.tier];
  const fallback = fallbackFor(model);
  const betas = [...(opts.compaction ? [COMPACTION_BETA] : []), ...(fallback ? [FALLBACK_BETA] : [])];

  return withSpan(
    `chat ${model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": model,
        "gen_ai.request.max_tokens": opts.maxTokens,
        "gen_ai.agent.name": opts.agent,
        "app.model.tier": opts.tier,
        "app.model.effort": opts.effort,
        ...(opts.round ? { "app.agent.round": opts.round } : {}),
      },
    },
    async (span) => {
      const start = performance.now();
      try {
        const response = await opts.client.beta.messages.create({
          model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: opts.messages,
          ...(opts.tools?.length ? { tools: opts.tools } : {}),
          output_config: {
            effort: opts.effort,
            ...(opts.outputSchema ? { format: { type: "json_schema", schema: opts.outputSchema } } : {}),
          },
          ...(opts.compaction ? { context_management: compactionConfig() } : {}),
          ...(fallback ? { fallbacks: [{ model: fallback }] } : {}),
          ...(betas.length ? { betas } : {}),
          // Cache the growing prefix: tool rounds and revisions re-send it.
          cache_control: { type: "ephemeral" },
        });
        opts.ledger.record(response.model, response);

        const fallbackUsed = (response.usage.iterations ?? []).some((it) => it.type === "fallback_message");
        span.setAttributes({
          "gen_ai.response.id": response.id,
          "gen_ai.response.model": response.model,
          "gen_ai.response.finish_reasons": [response.stop_reason ?? "unknown"],
          "gen_ai.usage.input_tokens": response.usage.input_tokens,
          "gen_ai.usage.output_tokens": response.usage.output_tokens,
          "app.fallback.used": fallbackUsed,
        });
        logger.info("llm.call.completed", {
          agent: opts.agent,
          tier: opts.tier,
          effort: opts.effort,
          requested_model: model,
          served_by: response.model,
          fallback_used: fallbackUsed,
          round: opts.round,
          response_id: response.id,
          request_id: response._request_id ?? undefined,
          stop_reason: response.stop_reason,
          requested_tools: response.content.filter((b) => b.type === "tool_use").map((b) => b.name),
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
          duration_ms: elapsedMs(start),
        });
        if (response.stop_reason === "refusal") {
          logger.warn("llm.call.refused", {
            agent: opts.agent,
            served_by: response.model,
            category: response.stop_details?.category ?? null,
            fallback_attempted: Boolean(fallback),
          });
        }
        return response;
      } catch (err) {
        logger.error("llm.call.failed", { agent: opts.agent, tier: opts.tier, model, error: err, duration_ms: elapsedMs(start) });
        throw err;
      }
    }
  );
}

/** Text of a response (text blocks only — thinking, compaction and fallback markers excluded). */
export function responseText(response: Anthropic.Beta.BetaMessage) {
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Parses a structured-output response; null if the model refused, truncated, or returned bad JSON. */
export function parseJson<T>(response: Anthropic.Beta.BetaMessage): T | null {
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  try {
    return JSON.parse(responseText(response)) as T;
  } catch {
    return null;
  }
}

/** Display name for the UI caption ("Sonnet 5.5"). */
export function modelLabel(model: string) {
  const m = /^claude-(haiku|sonnet|opus|fable|mythos)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
