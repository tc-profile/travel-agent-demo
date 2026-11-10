/**
 * Multi-agent orchestrator — one customer turn:
 *
 *   input guardrails ─► router (fast) ─► specialists in parallel (tier per routing table)
 *        │                  │                      │
 *        │ (block)          │ (unsafe/injection)   ▼
 *        ▼                  ▼             synthesizer (if >1 specialist)
 *     canned reply      canned reply               │
 *                                                   ▼
 *                         output guardrails ─► self-evaluation (judge) ─► one revision
 *                                                                      (escalated tier if scores ≤ 2)
 *                                                   │
 *                                                   ▼
 *                             final guardrail check ─► reply + model-agnostic history
 *
 * Patterns: routing (router), parallelization + orchestrator-workers (specialists + synthesizer),
 * evaluator-optimizer (judge + revision), model cascade (escalation on failed review).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { elapsedMs, logger, SpanKind, userText, withSpan } from "../observability";
import { connectWeatherMcp, type WeatherMcpSession, type WeatherReport } from "../weatherMcp";
import { evaluateDraft, feedbackFor, shouldEvaluate, type EvaluationResult } from "./evaluator";
import { CARD_NOTICE, checkInput, checkOutput, SAFE_FALLBACK_REPLY, TOOL_ALLOWLIST } from "./guardrails";
import { appendTurn, historyDigest, historyText, sanitizeHistory } from "./history";
import {
  callClaude,
  escalate,
  MODELS,
  modelLabel,
  responseText,
  routeModel,
  tierRank,
  UsageLedger,
  type AgentName,
  type Tier,
} from "./models";
import { routeRequest, type RouteDecision } from "./router";
import { reviseSpecialist, runSpecialist, SPECIALISTS, type SpecialistRun } from "./specialists";

const MAX_REVISIONS = Math.max(0, Math.min(2, Number.parseInt(process.env.EVAL_MAX_REVISIONS ?? "1", 10) || 0));

export type TurnOutcome =
  | "answered_with_tools"
  | "answered"
  | "clarifying_question"
  | "blocked_by_guardrail"
  | "refused"
  | "truncated"
  | "tool_limit_reached";

export type ReviewStatus = "passed" | "revised" | "fallback_reply" | "unreviewed" | "skipped";

export type AgentTurnResult = {
  /** Updated shared history (model-agnostic: text + compaction summaries). */
  messages: Anthropic.Beta.BetaMessageParam[];
  reply: string;
  weather: WeatherReport[];
  intent: { primary: string; all: string[] };
  outcome: TurnOutcome;
  compactions: number;
  /** For the UI caption: who answered, on which model, and whether it was self-checked. */
  meta: { agents: { name: string; model: string }[]; review: ReviewStatus; escalated: boolean };
};

const SYNTH_SYSTEM = `You merge answers from Aviana Travel's specialist agents into ONE reply to the customer (a demo travel assistant).
- Keep every fact exactly as the specialists gave it; do not add flights, hotels, prices, weather or policy details of your own.
- Remove repetition, order the parts to follow the customer's question, keep markdown formatting, stay concise.
- Keep any disclaimers (mock demo data, weather estimates, "not from Aviana's documents").
- If <evaluator_feedback> is present, fix every issue it lists using only the specialists' material.
Reply with the merged answer only.`;

const BLOCKED_REPLIES: Record<"unsafe" | "prompt_injection", string> = {
  unsafe: "I can't help with that. I'm here to help plan trips — flights, hotels, weather and Aviana's travel policies. Where would you like to go?",
  prompt_injection:
    "I can only help with travel planning, and I can't change how I work or share my internal instructions. Happy to help with a trip, the weather somewhere, or Aviana's policies!",
};

export async function runAgentTurn(
  client: Anthropic,
  rawHistory: unknown[],
  meta: { userMessage: string; conversationId?: string }
): Promise<AgentTurnResult> {
  return withSpan(
    "invoke_agent aviana-trip-planner",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "orchestrator",
        ...(meta.conversationId ? { "gen_ai.conversation.id": meta.conversationId } : {}),
      },
    },
    async (span) => {
      const start = performance.now();
      const ledger = new UsageLedger();
      const history = sanitizeHistory(rawHistory);
      logger.info("agent.turn.started", {
        intent: { user_message: userText(meta.userMessage) },
        conversation_id: meta.conversationId,
        history_messages: history.length,
        models: MODELS,
      });

      const done = (result: AgentTurnResult, extra: Record<string, unknown> = {}) => {
        const cost = ledger.summary();
        span.setAttributes({
          "app.intent": result.intent.primary,
          "app.outcome": result.outcome,
          "app.review": result.meta.review,
          "app.escalated": result.meta.escalated,
          "app.cost.est_usd": cost.est_cost_usd,
        });
        logger.info("agent.turn.completed", {
          intent: { primary: result.intent.primary, all: result.intent.all, user_message: userText(meta.userMessage) },
          outcome: result.outcome,
          review: result.meta.review,
          escalated: result.meta.escalated,
          agents: result.meta.agents,
          conversation_id: meta.conversationId,
          compactions: result.compactions,
          weather_cards: result.weather.length,
          reply_chars: result.reply.length,
          cost,
          duration_ms: elapsedMs(start),
          ...extra,
        });
        return result;
      };

      // 1. Input guardrails (deterministic).
      const input = checkInput(meta.userMessage);
      if (input.blocked) {
        return done(
          blockedResult(history, input.blocked.reply, "blocked_input", false),
          { guardrail: input.blocked.reason }
        );
      }

      // 2. Route.
      const digest = historyDigest(history);
      const route = await routeRequest({ client, ledger, digest, message: input.message, injectionSignals: input.injectionSignals });
      if (route.safety === "unsafe" || route.safety === "prompt_injection") {
        logger.warn("guardrail.input.blocked", { outcome: "blocked", reason: route.safety, rationale: route.rationale });
        const reply = BLOCKED_REPLIES[route.safety];
        return done(blockedResult(appendTurn(history, input.message, reply, null), reply, route.intent, true), {
          guardrail: route.safety,
        });
      }

      // 3. Specialists, in parallel, each on the tier the routing table assigns.
      const needsWeather = route.tasks.some((t) => TOOL_ALLOWLIST[t.agent].includes("get_weather"));
      const mcp = needsWeather ? await openWeatherMcp() : null;
      try {
        const deps = { client, ledger, mcp };
        const settled = await Promise.allSettled(
          route.tasks.map((task) => {
            const { tier, effort } = routeModel(task.agent, route.complexity);
            logger.info("router.assignment", { agent: task.agent, tier, effort, model: MODELS[tier], complexity: route.complexity });
            return runSpecialist(deps, { agent: task.agent, tier, effort, history, userMessage: input.message, brief: task.brief });
          })
        );
        let runs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
        const failed = settled.filter((s) => s.status === "rejected");
        if (!runs.length) throw (failed[0] as PromiseRejectedResult).reason;
        if (failed.length) logger.warn("agent.task.failed", { outcome: "partial", failed: failed.length, error: (failed[0] as PromiseRejectedResult).reason });

        // 4. Draft (single specialist answer, or a synthesis of several).
        let synthTier: Tier = "balanced";
        let draft = runs.length === 1 ? runs[0].reply : await synthesize(client, ledger, synthTier, input.message, runs);
        const agents = runs.map((r) => r.agent);
        const producerTier = runs.reduce<Tier>((t, r) => (tierRank(r.tier) > tierRank(t) ? r.tier : t), runs.length > 1 ? synthTier : runs[0].tier);
        const evidenceFor = (rs: SpecialistRun[]) => JSON.stringify(rs.flatMap((r) => r.evidence)) + "\n" + historyText(history);

        // 5. Output guardrails + self-evaluation + (at most) one revision.
        let findings = checkOutput(draft, { userMessage: input.message, evidence: evidenceFor(runs) });
        let review: ReviewStatus = "skipped";
        let escalated = false;
        let evaluation: EvaluationResult = { status: "skipped", reason: "" };
        const gate = shouldEvaluate(agents, findings);

        if (gate.evaluate) {
          evaluation = await evaluateDraft({
            client,
            ledger,
            producerTier,
            agents,
            digest,
            userMessage: input.message,
            draft,
            evidence: runs.flatMap((r) => r.evidence),
            findings,
          });
          if (evaluation.status === "done" && evaluation.passed) review = "passed";
          else if (evaluation.status === "done" && MAX_REVISIONS > 0) {
            const feedback = feedbackFor(evaluation.evaluation, findings);
            const wantEscalation = evaluation.minScore <= 2;
            logger.info("agent.revision.started", {
              intent: { action: "revise_draft", issues: evaluation.evaluation.issues.slice(0, 3) },
              agents,
              escalate: wantEscalation,
            });
            if (runs.length === 1) {
              const tier = (wantEscalation && escalate(runs[0].tier)) || runs[0].tier;
              escalated = tier !== runs[0].tier;
              runs = [await reviseSpecialist(deps, runs[0], feedback, tier)];
              draft = runs[0].reply;
            } else {
              const tier = (wantEscalation && escalate(synthTier)) || synthTier;
              escalated = tier !== synthTier;
              synthTier = tier;
              draft = await synthesize(client, ledger, synthTier, input.message, runs, feedback);
            }
            findings = checkOutput(draft, { userMessage: input.message, evidence: evidenceFor(runs) });
            review = "revised";
          } else {
            review = "unreviewed";
          }
        }

        // 6. Final hard stop: a blocking finding that survived review never reaches the customer.
        if (findings.some((f) => f.severity === "block")) {
          logger.error("guardrail.output.blocked", { outcome: "fallback_reply", findings: findings.map((f) => f.rule) });
          draft = SAFE_FALLBACK_REPLY;
          review = "fallback_reply";
        } else if (findings.length) {
          logger.warn("guardrail.output.flagged", { outcome: "allowed", findings });
        }

        // 7. Assemble the turn.
        const refused = runs.every((r) => r.stopReason === "refusal");
        if (!draft.trim()) {
          draft = refused
            ? "Sorry — I can't help with that request. I'm happy to help plan a trip, check the weather, or explain Aviana's policies."
            : "Sorry, I couldn't put an answer together for that. Could you rephrase?";
        }
        let reply = draft;
        if (input.cardsRedacted) reply = `${reply}\n\n${CARD_NOTICE}`;

        const compaction = runs.find((r) => r.compaction)?.compaction ?? null;
        const toolsUsed = runs.flatMap((r) => r.toolCalls.filter((t) => t.ok).map((t) => t.name));
        const outcome: TurnOutcome = review === "fallback_reply"
          ? "blocked_by_guardrail"
          : refused
          ? "refused"
          : runs.some((r) => r.toolLimitReached)
            ? "tool_limit_reached"
            : runs.some((r) => r.stopReason === "max_tokens")
              ? "truncated"
              : toolsUsed.length
                ? "answered_with_tools"
                : reply.trim().endsWith("?")
                  ? "clarifying_question"
                  : "answered";

        return done(
          {
            messages: appendTurn(history, input.message, reply, compaction),
            reply,
            weather: dedupeWeather(runs.flatMap((r) => r.weather)),
            intent: { primary: route.intent, all: [...new Set([route.intent, ...observedIntents(toolsUsed)])] },
            outcome,
            compactions: compaction ? 1 : 0,
            meta: {
              agents: runs.map((r) => ({ name: SPECIALISTS[r.agent].displayName, model: modelLabel(r.model) })),
              review,
              escalated,
            },
          },
          {
            route: summarizeRoute(route),
            guardrail_findings: findings.map((f) => f.rule),
            cards_redacted: input.cardsRedacted,
            evaluation: evaluation.status === "done" ? { passed: evaluation.passed, min_score: evaluation.minScore, judge_tier: evaluation.judgeTier } : evaluation.status,
          }
        );
      } finally {
        await mcp?.close().catch(() => {});
      }
    }
  );
}

async function synthesize(
  client: Anthropic,
  ledger: UsageLedger,
  tier: Tier,
  userMessage: string,
  runs: SpecialistRun[],
  feedback?: string
) {
  return withSpan(
    "invoke_agent synthesizer",
    { kind: SpanKind.INTERNAL, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "synthesizer", "app.model.tier": tier } },
    async () => {
      const parts = runs.map((r) => `<specialist agent="${r.agent}">\n${r.reply}\n</specialist>`).join("\n\n");
      const response = await callClaude({
        client,
        agent: "synthesizer",
        tier,
        effort: "low",
        system: SYNTH_SYSTEM,
        maxTokens: 6000,
        ledger,
        messages: [
          {
            role: "user",
            content: `<customer_message>\n${userMessage}\n</customer_message>\n\n${parts}${feedback ? `\n\n<evaluator_feedback>\n${feedback}\n</evaluator_feedback>` : ""}`,
          },
        ],
      });
      // If synthesis fails to produce text, fall back to concatenating the specialists' answers.
      return responseText(response).trim() || runs.map((r) => r.reply).join("\n\n");
    }
  );
}

async function openWeatherMcp(): Promise<WeatherMcpSession | null> {
  try {
    return await connectWeatherMcp();
  } catch (err) {
    logger.warn("mcp.connect.failed", { outcome: "degraded", error: err, impact: "get_weather unavailable this turn" });
    return null;
  }
}

function blockedResult(
  messages: Anthropic.Beta.BetaMessageParam[],
  reply: string,
  intent: string,
  routed: boolean
): AgentTurnResult {
  return {
    messages,
    reply,
    weather: [],
    intent: { primary: intent, all: [intent] },
    outcome: "blocked_by_guardrail",
    compactions: 0,
    meta: { agents: routed ? [{ name: "Guardrails", model: modelLabel(MODELS.fast) }] : [{ name: "Guardrails", model: "rules" }], review: "skipped", escalated: false },
  };
}

const INTENT_BY_TOOL: Record<string, string> = {
  search_flights: "trip_planning",
  search_hotels: "trip_planning",
  search_knowledge_base: "policy_question",
  get_weather: "weather_lookup",
};

function observedIntents(tools: string[]) {
  return [...new Set(tools.map((t) => INTENT_BY_TOOL[t]).filter(Boolean))];
}

function dedupeWeather(reports: WeatherReport[]) {
  const seen = new Set<string>();
  return reports.filter((w) => {
    const key = `${w.location}|${w.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeRoute(route: RouteDecision) {
  return {
    safety: route.safety,
    complexity: route.complexity,
    agents: route.tasks.map((t: { agent: AgentName }) => t.agent),
    degraded: Boolean(route.degraded),
  };
}
