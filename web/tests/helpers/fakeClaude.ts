import type Anthropic from "@anthropic-ai/sdk";
import { SPECIALISTS } from "@/lib/agents/specialists";

/**
 * Scripted stand-in for the Anthropic client. Every `client.beta.messages.create` call is recorded
 * and answered by a handler for the agent that made it. The agent is identified from the request
 * itself (structured-output schema for router/evaluator, the specialist's system prompt, else the
 * synthesizer), so tests don't depend on prompt wording.
 */
export type AgentKey =
  | "router"
  | "evaluator"
  | "synthesizer"
  | "trip_planner"
  | "policy_expert"
  | "weather_specialist"
  | "concierge";

export type Params = Anthropic.Beta.MessageCreateParamsNonStreaming & Record<string, unknown>;
export type Handler = (params: Params, ctx: { call: number }) => unknown | Promise<unknown>;
export type RecordedCall = { agent: AgentKey; model: string; effort?: string; params: Params };

export function agentOf(params: Params): AgentKey {
  const schema = (params.output_config as { format?: { schema?: { properties?: Record<string, unknown> } } } | undefined)
    ?.format?.schema?.properties;
  if (schema?.tasks) return "router";
  if (schema?.verdict) return "evaluator";
  for (const spec of Object.values(SPECIALISTS)) {
    if (params.system === spec.system) return spec.name;
  }
  return "synthesizer";
}

export function fakeClaude(handlers: Partial<Record<AgentKey, Handler>>) {
  const calls: RecordedCall[] = [];
  const perAgent = new Map<AgentKey, number>();
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          const agent = agentOf(params);
          const n = (perAgent.get(agent) ?? 0) + 1;
          perAgent.set(agent, n);
          calls.push({
            agent,
            model: params.model,
            effort: (params.output_config as { effort?: string } | undefined)?.effort,
            params: structuredClone(params),
          });
          const handler = handlers[agent];
          if (!handler) throw new Error(`fakeClaude: unexpected call from agent '${agent}'`);
          return handler(params, { call: n });
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

let seq = 0;

export function message(
  params: Params,
  stopReason: string,
  content: unknown[],
  usage: Partial<Anthropic.Beta.BetaUsage> = {}
): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_test_${++seq}`,
    type: "message",
    role: "assistant",
    model: params.model,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    content,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
      ...usage,
    },
  } as unknown as Anthropic.Beta.BetaMessage;
}

export const text = (t: string) => ({ type: "text", text: t, citations: null });
export const json = (o: unknown) => text(JSON.stringify(o));
export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

export const reply = (t: string): Handler => (p) => message(p, "end_turn", [text(t)]);

export const route = (decision: {
  safety?: string;
  intent?: string;
  complexity?: string;
  tasks: { agent: string; brief: string }[];
  rationale?: string;
}): Handler => (p) =>
  message(p, "end_turn", [
    json({ safety: "allow", intent: "trip_planning", complexity: "standard", rationale: "test", ...decision }),
  ]);

export const grade = (
  verdict: "pass" | "revise",
  scores: Partial<Record<"addresses_request" | "grounded" | "honest_disclosures" | "safety" | "clarity", number>> = {},
  issues: string[] = []
): Handler => (p) =>
  message(p, "end_turn", [
    json({
      verdict,
      scores: { addresses_request: 5, grounded: 5, honest_disclosures: 5, safety: 5, clarity: 5, ...scores },
      issues,
      revision_instructions: verdict === "pass" ? "" : "Fix the issues.",
    }),
  ]);

/** tool_result blocks of the latest user turn in a request. */
export function lastToolResults(params: Params): { tool_use_id: string; content: string; is_error?: boolean }[] {
  const last = params.messages[params.messages.length - 1];
  return Array.isArray(last.content)
    ? (last.content.filter((b) => (b as { type: string }).type === "tool_result") as never)
    : [];
}

/** Every block type that appears in a message list (to assert the shared history stays text-only). */
export function blockTypes(messages: Anthropic.Beta.BetaMessageParam[]) {
  return new Set(
    messages.flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => (b as { type: string }).type) : ["string"]))
  );
}
