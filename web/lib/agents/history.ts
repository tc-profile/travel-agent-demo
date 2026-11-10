/**
 * The shared customer conversation, as stored by the browser and sent to every agent.
 *
 * It is deliberately MODEL-AGNOSTIC: only customer text, final assistant replies, and compaction
 * summaries. Each specialist's tool calls and thinking stay inside that specialist's single-model
 * run, so routing different turns to Haiku, Sonnet or Opus never replays one model's thinking or
 * tool blocks into another, and a browser can't smuggle forged tool results or thinking into the
 * context (anything else is stripped here).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { trimToLatestCompaction } from "../compaction";
import { logger } from "../observability";

type Message = Anthropic.Beta.BetaMessageParam;
const MAX_TEXT_CHARS = 20_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n");
}

/** Keeps only user text, assistant text and compaction blocks; trims to the latest summary. */
export function sanitizeHistory(raw: unknown[]): Message[] {
  const out: Message[] = [];
  let droppedBlocks = 0;

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      droppedBlocks++;
      continue;
    }
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role === "user") {
      const text = textOf(content).slice(0, MAX_TEXT_CHARS);
      if (Array.isArray(content)) droppedBlocks += content.filter((b) => (b as { type?: unknown })?.type !== "text").length;
      if (text) out.push({ role: "user", content: text });
    } else if (role === "assistant") {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const b of Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }]) {
        const block = b as { type?: unknown; text?: unknown; content?: unknown; encrypted_content?: unknown };
        if (block.type === "compaction") {
          // Round-trip exactly the fields the API returned — no additions.
          blocks.push({
            type: "compaction",
            content: typeof block.content === "string" ? block.content : null,
            ...(typeof block.encrypted_content === "string" ? { encrypted_content: block.encrypted_content } : {}),
          });
        } else if (block.type === "text" && typeof block.text === "string" && block.text) {
          blocks.push({ type: "text", text: block.text.slice(0, MAX_TEXT_CHARS) });
        } else {
          droppedBlocks++;
        }
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else {
      droppedBlocks++;
    }
  }

  const { messages, dropped } = trimToLatestCompaction(out);
  if (droppedBlocks) {
    logger.warn("guardrail.history.sanitized", { outcome: "stripped", dropped_blocks: droppedBlocks });
  }
  if (dropped) logger.debug("history.trimmed_to_summary", { messages_dropped: dropped });
  return messages;
}

/** The summary (if any) + the last few turns as plain text — compact context for router/evaluator. */
export function historyDigest(history: Message[], maxMessages = 6, maxChars = 600): string {
  const parts: string[] = [];
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "compaction" && typeof b.content === "string") parts.push(`[Summary of earlier conversation]\n${b.content}`);
    }
  }
  const recent = history.slice(-maxMessages).map((m) => {
    const text = textOf(m.content).trim();
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    return `${m.role === "user" ? "Customer" : "Assistant"}: ${clipped}`;
  });
  return [...parts.slice(-1), ...recent].join("\n\n") || "(no earlier conversation)";
}

/** Full text of the conversation, for grounding checks (what earlier turns already told the customer). */
export function historyText(history: Message[]): string {
  return history
    .map((m) =>
      Array.isArray(m.content)
        ? m.content.map((b) => (b.type === "text" ? b.text : b.type === "compaction" ? (b.content ?? "") : "")).join("\n")
        : String(m.content)
    )
    .join("\n");
}

/**
 * The history after this turn. If a specialist's request compacted the context, the summary covers
 * everything up to and including this turn's customer message, so history restarts at it.
 */
export function appendTurn(
  history: Message[],
  userMessage: string,
  reply: string,
  compaction: Anthropic.Beta.BetaCompactionBlock | null
): Message[] {
  if (compaction) {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "compaction",
            content: compaction.content,
            ...(compaction.encrypted_content ? { encrypted_content: compaction.encrypted_content } : {}),
          },
          { type: "text", text: reply },
        ],
      },
    ];
  }
  return [...history, { role: "user", content: userMessage }, { role: "assistant", content: [{ type: "text", text: reply }] }];
}
