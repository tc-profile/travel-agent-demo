import Anthropic from "@anthropic-ai/sdk";
import {
  COMPACTION_BETA,
  COMPACTION_TRIGGER_TOKENS,
  compactionConfig,
  compactionInResponse,
  trimToLatestCompaction,
} from "./compaction";
import { searchKnowledgeBase } from "./knowledge";
import {
  elapsedMs,
  logger,
  SpanKind,
  SpanStatusCode,
  userText,
  withSpan,
  type LogFields,
} from "./observability";
import { searchFlights, searchHotels } from "./tools";
import { connectWeatherMcp, type WeatherMcpSession, type WeatherReport } from "./weatherMcp";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

/** Hard cap on tool-call rounds within a single turn, so a pathological loop can't run away on cost. */
const MAX_TOOL_ROUNDS = 6;

export const SYSTEM_PROMPT = `You are a travel planning assistant demo.

Goal: help the user plan a trip. Before calling any tools, make sure you
know the origin, destination, travel dates, and (if relevant) budget or
preferences — ask concise follow-up questions for anything missing.

Once you have enough information, call the available tools to gather
flight options, hotel options, and weather, then propose a clear
day-by-day itinerary with your top flight and hotel picks and a packing
note based on the weather.

Flight and hotel data are clearly-labeled MOCK data for this demo — say so
plainly if the user asks whether they can book through you (they can't).
Weather data is real (or, when the date is too far out for a forecast, an
estimate based on the same date last year — say so when you use it). Each
get_weather result is also shown to the customer as a weather card next to
your reply, so summarize it briefly rather than repeating every number.

You also have access to search_knowledge_base, which searches Aviana's own
reference documents (booking/cancellation policy, loyalty program, baggage
rules, entry-document guidance, group bookings). Call it when a question
might be answered by that material — policy, fees, loyalty program, baggage,
documents — rather than guessing. If it returns no useful match, fall back
to your general knowledge and say the answer isn't from Aviana's documents.

Keep responses concise and skimmable: short paragraphs, bullet points for
options and itinerary days. Format with markdown.`;

/** Locally-implemented tools. get_weather is NOT here — it's discovered from the weather MCP server (lib/weatherMcp.ts). */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_flights",
    description:
      "Search for flights between two cities on a given date. Returns MOCK data for demo purposes, not real bookable flights.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin city or airport" },
        destination: { type: "string", description: "Destination city or airport" },
        date: { type: "string", description: "Departure date, YYYY-MM-DD" },
      },
      required: ["origin", "destination", "date"],
    },
  },
  {
    name: "search_hotels",
    description:
      "Search for hotels in a destination city for a date range. Returns MOCK data for demo purposes, not real bookable hotels.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Destination city" },
        checkin: { type: "string", description: "Check-in date, YYYY-MM-DD" },
        checkout: { type: "string", description: "Check-out date, YYYY-MM-DD" },
        max_price_per_night: { type: "number", description: "Optional budget ceiling per night, in USD" },
      },
      required: ["destination", "checkin", "checkout"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Search Aviana's own reference documents — booking/cancellation policy, loyalty program, baggage rules, entry-document guidance, group bookings, customer support — for a relevant passage. Use for policy/fee/program questions instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        top_k: { type: "integer", description: "Number of matching passages to return (default 4)" },
      },
      required: ["query"],
    },
  },
];

type ToolInput = Record<string, unknown>;

const TOOL_FUNCTIONS: Record<string, (input: ToolInput) => unknown | Promise<unknown>> = {
  search_flights: (i) => searchFlights(i.origin as string, i.destination as string, i.date as string),
  search_hotels: (i) =>
    searchHotels(
      i.destination as string,
      i.checkin as string,
      i.checkout as string,
      i.max_price_per_night as number | undefined
    ),
  search_knowledge_base: (i) => searchKnowledgeBase(i.query as string, (i.top_k as number) ?? 4),
};

// ---------------------------------------------------------------------------
// Intent & outcome
// ---------------------------------------------------------------------------

/**
 * Intent is inferred from what the agent actually did (which tools it chose), not from a separate
 * classifier call — free, deterministic, and grounded in behavior. Primary intent by priority.
 */
const INTENT_BY_TOOL: Record<string, string> = {
  search_flights: "trip_planning",
  search_hotels: "trip_planning",
  search_knowledge_base: "policy_question",
  get_weather: "weather_lookup",
};
const INTENT_PRIORITY = ["trip_planning", "policy_question", "weather_lookup"];

export type TurnIntent = { primary: string; all: string[] };

function inferIntent(toolsUsed: string[]): TurnIntent {
  const all = [...new Set(toolsUsed.map((t) => INTENT_BY_TOOL[t] ?? "other_tool"))];
  const primary = INTENT_PRIORITY.find((i) => all.includes(i)) ?? all[0] ?? "general_conversation";
  return { primary, all };
}

export type TurnOutcome =
  | "answered_with_tools"
  | "answered"
  | "clarifying_question"
  | "tool_limit_reached"
  | "refused"
  | "truncated";

function inferOutcome(stopReason: string | null, toolsUsed: string[], reply: string): TurnOutcome {
  if (stopReason === "refusal") return "refused";
  if (stopReason === "max_tokens") return "truncated";
  if (toolsUsed.length > 0) return "answered_with_tools";
  // No tools + reply ending in a question: the agent is gathering missing trip details.
  return reply.trim().endsWith("?") ? "clarifying_question" : "answered";
}

/** Tool arguments safe to log (customer free text goes through the LOG_USER_CONTENT policy). */
function toolIntent(name: string, input: ToolInput) {
  if (name === "search_knowledge_base") {
    return { tool: name, args: { query: userText(String(input.query ?? "")), top_k: input.top_k } };
  }
  return { tool: name, args: input };
}

/** One-line description of a tool result for logs — counts and labels, never full payloads. */
function summarizeResult(result: unknown): LogFields {
  if (!result || typeof result !== "object") return {};
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string") return { error_message: r.error };
  if (Array.isArray(r.results)) return { result_count: r.results.length };
  if (Array.isArray(r.matches)) {
    return {
      match_count: r.matches.length,
      sources: [...new Set(r.matches.map((m) => (m as { source?: string }).source).filter(Boolean))],
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/** Opens the weather MCP session; if it can't connect, the agent still runs, just without weather. */
async function openWeatherMcp(): Promise<WeatherMcpSession | null> {
  try {
    return await connectWeatherMcp();
  } catch (err) {
    logger.warn("mcp.connect.failed", { outcome: "degraded", error: err, impact: "get_weather unavailable this turn" });
    return null;
  }
}

type ToolCallRecord = { name: string; ok: boolean; transport: "mcp" | "local" };

async function executeTool(
  block: Anthropic.Beta.BetaToolUseBlock,
  mcp: WeatherMcpSession | null,
  weather: WeatherReport[]
): Promise<{ result: Anthropic.Beta.BetaToolResultBlockParam; record: ToolCallRecord }> {
  const input = block.input as ToolInput;
  const transport = mcp?.has(block.name) ? "mcp" : "local";

  return withSpan(
    `execute_tool ${block.name}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": block.name,
        "gen_ai.tool.call.id": block.id,
        "gen_ai.tool.type": "function",
        "app.tool.transport": transport,
        ...(transport === "mcp" ? { "mcp.method.name": "tools/call", "mcp.transport": mcp!.transport } : {}),
      },
    },
    async (span) => {
      const start = performance.now();
      const intent = toolIntent(block.name, input);
      logger.info("tool.call.started", { intent, tool_call_id: block.id, transport });

      let content: string;
      let isError = false;
      let summary: LogFields = {};
      try {
        if (transport === "mcp") {
          const outcome = await mcp!.call(block.name, input);
          content = outcome.text;
          isError = outcome.isError;
          if (outcome.weather) {
            weather.push(outcome.weather);
            summary = {
              location: outcome.weather.location,
              conditions: outcome.weather.conditions,
              weather_source: outcome.weather.source === "live forecast" ? "forecast" : "last_year_estimate",
            };
          } else if (isError) {
            summary = summarizeResult(safeJson(content));
          }
        } else {
          const fn = TOOL_FUNCTIONS[block.name];
          if (!fn) throw new Error(`Unknown tool '${block.name}'.`);
          const value = await fn(input);
          content = JSON.stringify(value);
          summary = summarizeResult(value);
          // Local tools report soft failures as { error } payloads rather than throwing.
          isError = typeof (value as { error?: unknown })?.error === "string";
        }
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        isError = true;
        summary = { error: err };
        span.recordException(err instanceof Error ? err : new Error(String(err)));
      }

      const outcome = isError ? "error" : "ok";
      span.setAttribute("app.outcome", outcome);
      if (isError) span.setStatus({ code: SpanStatusCode.ERROR, message: "tool returned an error" });
      (isError ? logger.warn : logger.info)(isError ? "tool.call.failed" : "tool.call.completed", {
        intent,
        outcome,
        tool_call_id: block.id,
        transport,
        duration_ms: elapsedMs(start),
        ...summary,
      });

      return {
        result: { type: "tool_result", tool_use_id: block.id, content, is_error: isError || undefined },
        record: { name: block.name, ok: !isError, transport },
      };
    }
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Summarization cost — reported only in usage.iterations, not in the top-level usage. */
  compaction_input_tokens: number;
  compaction_output_tokens: number;
};

async function callModel(
  client: Anthropic,
  messages: Anthropic.Beta.BetaMessageParam[],
  tools: Anthropic.Tool[],
  round: number,
  usage: Usage
) {
  return withSpan(
    `chat ${MODEL}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": MODEL,
        "gen_ai.request.max_tokens": 1500,
        "app.agent.round": round,
        "app.compaction.trigger_tokens": COMPACTION_TRIGGER_TOKENS,
      },
    },
    async (span) => {
      const start = performance.now();
      try {
        const response = await client.beta.messages.create({
          betas: [COMPACTION_BETA],
          model: MODEL,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools,
          messages,
          // Summarize older history server-side once input crosses the trigger (lib/compaction.ts).
          context_management: compactionConfig(),
          // Cache the growing conversation prefix: every tool round and every turn re-sends it.
          cache_control: { type: "ephemeral" },
        });
        const toolCalls = response.content.filter((b) => b.type === "tool_use").map((b) => b.name);
        usage.input_tokens += response.usage.input_tokens;
        usage.output_tokens += response.usage.output_tokens;
        usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
        usage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
        span.setAttributes({
          "gen_ai.response.id": response.id,
          "gen_ai.response.model": response.model,
          "gen_ai.response.finish_reasons": [response.stop_reason ?? "unknown"],
          "gen_ai.usage.input_tokens": response.usage.input_tokens,
          "gen_ai.usage.output_tokens": response.usage.output_tokens,
        });
        logger.info("llm.call.completed", {
          round,
          model: response.model,
          response_id: response.id,
          request_id: response._request_id ?? undefined,
          stop_reason: response.stop_reason,
          requested_tools: toolCalls,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
          duration_ms: elapsedMs(start),
        });
        return response;
      } catch (err) {
        logger.error("llm.call.failed", { round, model: MODEL, error: err, duration_ms: elapsedMs(start) });
        throw err;
      }
    }
  );
}

/**
 * If this response compacted the context, log/trace it and trim `messages` in place to start at
 * the new summary (the API ignores the earlier messages from now on). Returns true on success.
 */
function recordCompaction(
  response: Anthropic.Beta.BetaMessage,
  messages: Anthropic.Beta.BetaMessageParam[],
  round: number,
  usage: Usage
): boolean {
  const event = compactionInResponse(response);
  if (!event) return false;
  usage.compaction_input_tokens += event.input_tokens;
  usage.compaction_output_tokens += event.output_tokens;

  if (!event.succeeded) {
    // A null-content block is a no-op server-side; the full history stays in place.
    logger.warn("context.compaction.failed", {
      intent: { action: "summarize_history", trigger_tokens: COMPACTION_TRIGGER_TOKENS },
      outcome: "no_summary",
      round,
      compaction_input_tokens: event.input_tokens,
      impact: "history kept uncompacted; will retry on a later request",
    });
    return false;
  }

  const before = messages.length;
  const { messages: trimmed, dropped } = trimToLatestCompaction(messages);
  messages.splice(0, messages.length, ...trimmed);
  logger.info("context.compacted", {
    intent: { action: "summarize_history", trigger_tokens: COMPACTION_TRIGGER_TOKENS },
    outcome: "summarized",
    round,
    context_tokens_summarized: event.input_tokens,
    summary_tokens: event.output_tokens,
    summary_chars: event.summary_chars,
    messages_before: before,
    messages_dropped: dropped,
    messages_after: messages.length,
  });
  return true;
}

export type AgentTurnResult = {
  messages: Anthropic.Beta.BetaMessageParam[];
  reply: string;
  weather: WeatherReport[];
  intent: TurnIntent;
  outcome: TurnOutcome;
  /** Successful compactions this turn (the transcript returned starts at the latest summary). */
  compactions: number;
};

export async function runAgentTurn(
  client: Anthropic,
  messages: Anthropic.Beta.BetaMessageParam[],
  meta: { userMessage: string; conversationId?: string }
): Promise<AgentTurnResult> {
  return withSpan(
    "invoke_agent aviana-trip-planner",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "aviana-trip-planner",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": MODEL,
        ...(meta.conversationId ? { "gen_ai.conversation.id": meta.conversationId } : {}),
      },
    },
    async (span) => {
      const start = performance.now();
      const userMessage = userText(meta.userMessage);
      // Stated intent: what the customer typed. Inferred intent is logged at completion.
      logger.info("agent.turn.started", {
        intent: { user_message: userMessage },
        conversation_id: meta.conversationId,
        history_messages: messages.length - 1,
        model: MODEL,
      });

      const mcp = await openWeatherMcp();
      const tools = [...TOOLS, ...(mcp?.tools ?? [])];
      // Weather reports from MCP tool calls this turn, returned alongside the reply for the UI to render.
      const weather: WeatherReport[] = [];
      const toolCalls: ToolCallRecord[] = [];
      const usage: Usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        compaction_input_tokens: 0,
        compaction_output_tokens: 0,
      };
      let compactions = 0;
      let rounds = 0;

      const finish = (reply: string, outcome: TurnOutcome): AgentTurnResult => {
        const toolsUsed = toolCalls.map((t) => t.name);
        const intent = inferIntent(toolsUsed);
        const toolErrors = toolCalls.filter((t) => !t.ok).length;
        span.setAttributes({
          "app.intent": intent.primary,
          "app.intents": intent.all,
          "app.outcome": outcome,
          "app.agent.rounds": rounds,
          "app.agent.tool_calls": toolCalls.length,
          "app.agent.tool_errors": toolErrors,
          "app.compaction.count": compactions,
          "gen_ai.usage.input_tokens": usage.input_tokens,
          "gen_ai.usage.output_tokens": usage.output_tokens,
        });
        const level = outcome === "tool_limit_reached" || outcome === "refused" || outcome === "truncated" ? "warn" : "info";
        logger[level]("agent.turn.completed", {
          intent: { primary: intent.primary, all: intent.all, user_message: userMessage },
          outcome,
          degraded: toolErrors > 0 || mcp === null,
          conversation_id: meta.conversationId,
          rounds,
          tools_used: toolsUsed,
          tool_calls: toolCalls.length,
          tool_errors: toolErrors,
          mcp_available: mcp !== null,
          weather_cards: weather.length,
          compactions,
          reply_chars: reply.length,
          ...usage,
          duration_ms: elapsedMs(start),
        });
        return { messages, reply, weather, intent, outcome, compactions };
      };

      try {
        for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
          rounds = round;
          const response = await callModel(client, messages, tools, round, usage);
          messages.push({ role: "assistant", content: response.content });
          if (recordCompaction(response, messages, round, usage)) compactions++;

          if (response.stop_reason !== "tool_use") {
            const reply = response.content
              .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
              .map((block) => block.text)
              .join("");
            return finish(reply, inferOutcome(response.stop_reason, toolCalls.map((t) => t.name), reply));
          }

          const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const { result, record } = await executeTool(block, mcp, weather);
            toolResults.push(result);
            toolCalls.push(record);
          }
          messages.push({ role: "user", content: toolResults });
        }

        return finish(
          "I wasn't able to finish planning this within the demo's tool-call limit — try narrowing your request.",
          "tool_limit_reached"
        );
      } catch (err) {
        // Failed before the agent chose any tool → we genuinely don't know the intent yet.
        const intent = toolCalls.length > 0 ? inferIntent(toolCalls.map((t) => t.name)) : { primary: "undetermined", all: [] };
        span.setAttributes({ "app.intent": intent.primary, "app.outcome": "error" });
        logger.error("agent.turn.failed", {
          intent: { primary: intent.primary, all: intent.all, user_message: userMessage },
          outcome: "error",
          conversation_id: meta.conversationId,
          rounds,
          tools_used: toolCalls.map((t) => t.name),
          error: err,
          duration_ms: elapsedMs(start),
        });
        throw err;
      } finally {
        await mcp?.close().catch(() => {});
      }
    }
  );
}
