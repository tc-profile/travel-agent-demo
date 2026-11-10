import Anthropic from "@anthropic-ai/sdk";
import { trace } from "@opentelemetry/api";
import { runAgentTurn } from "@/lib/agent";
import { currentTraceId, elapsedMs, logger } from "@/lib/observability";

const MAX_HISTORY_MESSAGES = 60;
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

  const body = await request.json().catch(() => null);
  const priorMessages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessage = typeof body?.message === "string" ? body.message.trim() : "";

  if (!userMessage) return reject(400, "empty_message", "Message is required.");
  if (priorMessages.length > MAX_HISTORY_MESSAGES) {
    return reject(
      400,
      "history_too_long",
      "This demo conversation has gotten long — please refresh to start a new one."
    );
  }

  logger.info("chat.request.received", {
    conversation_id: conversationId,
    history_messages: priorMessages.length,
  });

  const messages: Anthropic.MessageParam[] = [...priorMessages, { role: "user", content: userMessage }];

  const client = new Anthropic({ apiKey });
  try {
    const { messages: updated, reply, weather, intent, outcome } = await runAgentTurn(client, messages, {
      userMessage,
      conversationId,
    });
    rootSpan?.setAttributes({ "app.intent": intent.primary, "app.outcome": outcome });
    logger.info("chat.request.completed", {
      outcome,
      intent: intent.primary,
      status: 200,
      conversation_id: conversationId,
      duration_ms: elapsedMs(start),
    });
    return respond({ messages: updated, reply, weather });
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
