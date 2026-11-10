/**
 * Historical context compaction for long chats.
 *
 * Uses the Claude API's server-side compaction (beta `compact-2026-01-12`, edit `compact_20260112`):
 * when a request's input crosses the trigger threshold, the API summarizes the earlier conversation
 * into a `compaction` block, answers from that summary, and returns the block at the start of the
 * assistant's content. On later requests the API ignores everything before the latest compaction
 * block, so the conversation can continue indefinitely at a bounded context size.
 *
 * This module:
 *   - builds the `context_management` config (threshold + travel-specific summary instructions);
 *   - trims the transcript to start at the latest *successful* compaction block, so the history the
 *     browser stores and re-sends each turn stays small (the API would ignore the prefix anyway);
 *   - reports what a compaction did, for logs/traces and the UI.
 *
 * The customer still sees their full chat in the widget — only the model's context is summarized.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const COMPACTION_BETA = "compact-2026-01-12";

/** The API's minimum trigger is 50,000 input tokens. */
const MIN_TRIGGER_TOKENS = 50_000;

/**
 * Compact once a request's input reaches this many tokens. Defaults to the API minimum: on a public
 * demo every round re-reads the whole context, so a lower ceiling bounds per-request cost (a trip
 * planning chat rarely needs more than ~50K tokens of verbatim history). Override with
 * COMPACTION_TRIGGER_TOKENS (values under 50,000 are raised to 50,000).
 */
export const COMPACTION_TRIGGER_TOKENS = Math.max(
  MIN_TRIGGER_TOKENS,
  Number.parseInt(process.env.COMPACTION_TRIGGER_TOKENS ?? "", 10) || MIN_TRIGGER_TOKENS
);

/** Replaces the API's default summary prompt, so the summary keeps what a trip planner needs. */
const SUMMARY_INSTRUCTIONS = `Summarize the conversation so far between a customer and Aviana's AI trip planner, so the planner can continue seamlessly from the summary alone.

Preserve precisely:
- Trip details: origin, destination(s), exact travel dates, number of travelers, budget, and stated preferences or constraints (pace, interests, accessibility, dietary, loyalty status).
- Decisions and shortlists: flights and hotels the customer liked, picked, or rejected (airline, flight number, hotel name, price), and why.
- Tool findings still relevant: weather per destination/date (and whether it was a live forecast or a same-date-last-year estimate), and any Aviana policy answers from the knowledge base.
- The current itinerary draft, day by day, if one exists.
- Open questions or details the planner still needs from the customer, and what the customer asked for last.

Note that flight and hotel results were MOCK demo data. Omit pleasantries and anything superseded by later changes. Do not call tools; respond with the summary text only.`;

export function compactionConfig(): Anthropic.Beta.BetaContextManagementConfig {
  return {
    edits: [
      {
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: COMPACTION_TRIGGER_TOKENS },
        instructions: SUMMARY_INSTRUCTIONS,
      },
    ],
  };
}

type Message = Anthropic.Beta.BetaMessageParam;

function compactionBlocks(message: Message) {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (b): b is Anthropic.Beta.BetaCompactionBlockParam => (b as { type?: string }).type === "compaction"
  );
}

/** A compaction that produced a summary. A `content: null` block is a failed attempt (a no-op). */
function hasSummary(message: Message) {
  return compactionBlocks(message).some((b) => typeof b.content === "string" && b.content.length > 0);
}

/**
 * Drops every message before the latest successful compaction block. The message holding the
 * block is kept whole (block first, then the reply/tool calls generated after it), byte-for-byte.
 * Failed compactions (`content: null`) are left in place and nothing is trimmed for them.
 */
export function trimToLatestCompaction(messages: Message[]): { messages: Message[]; dropped: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && hasSummary(messages[i])) {
      return { messages: messages.slice(i), dropped: i };
    }
  }
  return { messages, dropped: 0 };
}

export type CompactionEvent = {
  /** Whether a summary was produced (false = attempted but failed; the full history is kept). */
  succeeded: boolean;
  /** Tokens the summarizer read (≈ context size when compaction fired) and wrote. */
  input_tokens: number;
  output_tokens: number;
  summary_chars: number;
};

/**
 * Detects a compaction in a response. Compaction tokens are reported only in `usage.iterations`
 * (the top-level usage counts just the final message), so they are surfaced here for cost tracking.
 */
export function compactionInResponse(response: Anthropic.Beta.BetaMessage): CompactionEvent | null {
  const block = response.content.find((b): b is Anthropic.Beta.BetaCompactionBlock => b.type === "compaction");
  if (!block) return null;
  const usage = (response.usage.iterations ?? []).filter(
    (it): it is Anthropic.Beta.BetaCompactionIterationUsage => it.type === "compaction"
  );
  return {
    succeeded: typeof block.content === "string" && block.content.length > 0,
    input_tokens: usage.reduce((n, it) => n + it.input_tokens, 0),
    output_tokens: usage.reduce((n, it) => n + it.output_tokens, 0),
    summary_chars: block.content?.length ?? 0,
  };
}
