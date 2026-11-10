import Anthropic from "@anthropic-ai/sdk";
import { trace } from "@opentelemetry/api";
import { runAgentTurn } from "@/lib/agent";
import { COMPACTION_TRIGGER_TOKENS } from "@/lib/compaction";
import { currentTraceId, elapsedMs, logger } from "@/lib/observability";

/**
 * Abuse guards for the public endpoint. Long conversations are handled by compaction
 * (lib/compaction.ts): once the context passes COMPACTION_TRIGGER_TOKENS the API summarizes it and
 * the transcript sent back to the browser restarts at that summary, so a legitimate transcript stays
 * well under these limits however long the chat runs. They only stop oversized/forged payloads.
 */
const MAX_HISTORY_MESSAGES = 400;
const MAX_REQUEST_BYTES = 1_500_000; // ≈ 2-3x the compaction trigger, in JSON bytes
/** Client-generated conversation id (see ChatWidget). Validated because this endpoint is public. */
const CONVERSATION_ID = /^[A-Za-z0-9-]{8,64}$/;

export async function POST(request: Request) {
  const start = performance.now();
  // Next.js opens the root span for this request, continuing the browser's `traceparent` if sent.
  const rootSpan = trace.getActiveSpan();
  const traceId = currentTraceId();
  const rawConversationId = request.headers.get("x-conversation-id") ?? "";
  const conversationId = CONVERSATION_ID.test(rawConversationId) ? rawConversationId : undefined;
  rootSpan?.setAttributes({ "app.route": "/api/chat", ...(conversationId ? { "gen_ai.conversation.id": conversationId } : {}) });

  /** Every response carries the trace id (header + JSON) so a customer-facing error can be looked up. */
  const respond = (body: Record<string, unknown>, status = 200) =>
    Response.json({ ...body, ...(traceId ? { traceId } : {}) }, {
      status,
      headers: traceId ? { "x-trace-id": traceId } : undefined,
    });
  const reject = (status: number, reason: string, error: string) => {
    logger.warn("chat.request.rejected", { outcome: "rejected", reason, status, conversation_id: conversationId });
    return respond({ error }, status);
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("chat.request.misconfigured", { outcome: "error", reason: "missing_anthropic_api_key" });
    return respond({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_REQUEST_BYTES) {
    return reject(413, "request_too_large", "This conversation is too large to continue — please refresh to start a new one.");
  }
  let body: { messages?: unknown; message?: unknown } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const priorMessages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessage = typeof body?.message === "string" ? body.message.trim() : "";

  if (!userMessage) return reject(400, "empty_message", "Message is required.");
  if (priorMessages.length > MAX_HISTORY_MESSAGES) {
    return reject(
      400,
      "history_too_long",
      "This conversation is too long to continue — please refresh to start a new one."
    );
  }

  logger.info("chat.request.received", {
    conversation_id: conversationId,
    history_messages: priorMessages.length,
    request_bytes: raw.length,
    compaction_trigger_tokens: COMPACTION_TRIGGER_TOKENS,
  });

  const client = new Anthropic({ apiKey });
  try {
    // History is sanitized inside the agent (text + compaction summaries only).
    const { messages: updated, reply, weather, intent, outcome, compactions, meta } = await runAgentTurn(client, priorMessages, {
      userMessage,
      conversationId,
    });
    rootSpan?.setAttributes({ "app.intent": intent.primary, "app.outcome": outcome, "app.compaction.count": compactions });
    logger.info("chat.request.completed", {
      outcome,
      intent: intent.primary,
      review: meta.review,
      status: 200,
      conversation_id: conversationId,
      compactions,
      transcript_messages: updated.length,
      duration_ms: elapsedMs(start),
    });
    // `messages` restarts at the latest summary after a compaction, so the browser's copy stays small.
    return respond({ messages: updated, reply, weather, compacted: compactions > 0, meta });
  } catch (err) {
    rootSpan?.setAttribute("app.outcome", "error");
    logger.error("chat.request.failed", {
      outcome: "error",
      status: 500,
      conversation_id: conversationId,
      error: err,
      duration_ms: elapsedMs(start),
    });
    return respond({ error: "Something went wrong talking to the agent." }, 500);
  }
}
