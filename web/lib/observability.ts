/**
 * Observability primitives: structured JSON logging + OpenTelemetry tracing helpers.
 *
 * Logging — every log line is ONE JSON object on stdout/stderr (what Vercel's log drains and most
 * log backends ingest natively), stamped with the active span's `trace_id` / `span_id` so a log
 * search for a trace id returns every line from that request, across the chat route, the agent
 * loop, and the weather MCP server. Each log call is also recorded as an event on the active span,
 * so the same story is visible from inside a trace viewer even without a log backend.
 *
 * Event naming: `<area>.<thing>.<verb>` (e.g. `agent.turn.completed`, `tool.call.failed`). The
 * events that matter most carry two fields by convention:
 *   - `intent`  — what was being attempted (the user's ask, the tool + arguments the agent chose)
 *   - `outcome` — how it ended (`answered`, `clarifying_question`, `ok`, `error`, ...)
 *
 * Env:
 *   LOG_LEVEL          debug | info (default) | warn | error
 *   LOG_USER_CONTENT   preview (default: first 160 chars) | full | none — how much customer-typed
 *                      text (chat messages, knowledge-base queries) may appear in logs and spans.
 *
 * Tracing is registered in `instrumentation.ts` (via @vercel/otel); this module only uses the
 * vendor-neutral `@opentelemetry/api`, so it's a no-op if no tracer provider is registered.
 */
import {
  context,
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Span,
} from "@opentelemetry/api";

export const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "aviana-travel-web";
export const tracer = trace.getTracer("aviana-trip-planner", "1.0.0");
export { SpanKind, SpanStatusCode };

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL?.toLowerCase() as Level) ?? "info"] ?? LEVELS.info;
const ENVIRONMENT = process.env.VERCEL_ENV || process.env.NODE_ENV || "development";

export type LogFields = Record<string, unknown>;

function emit(level: Level, event: string, fields: LogFields = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  const traceFields =
    spanContext && isSpanContextValid(spanContext)
      ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
      : {};

  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    service: SERVICE_NAME,
    env: ENVIRONMENT,
    ...traceFields,
    ...fields,
  };

  let line: string;
  try {
    line = JSON.stringify(record, (_key, value) => (value instanceof Error ? serializeError(value) : value));
  } catch {
    line = JSON.stringify({ ...record, ...Object.fromEntries(Object.keys(fields).map((k) => [k, "[unserializable]"])) });
  }
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);

  span?.addEvent(event, { "log.level": level, ...toAttributes(fields) });
}

export const logger = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

export function serializeError(err: unknown) {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    // SDK errors (e.g. Anthropic's AuthenticationError) keep name "Error"; the class name is more useful.
    const ctorName = err.constructor?.name;
    return {
      type: ctorName && ctorName !== "Error" ? ctorName : err.name,
      message: err.message,
      ...(typeof status === "number" ? { status } : {}),
    };
  }
  return { type: "UnknownError", message: String(err) };
}

/** Flattens log fields into span attributes (OTel attributes must be primitives or primitive arrays). */
export function toAttributes(fields: LogFields, prefix = ""): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[name] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[name] = value as AttributeValue;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
      out[name] = value as AttributeValue;
    } else {
      out[name] = JSON.stringify(value instanceof Error ? serializeError(value) : value);
    }
  }
  return out;
}

/**
 * Runs `fn` inside a new active span. Exceptions are recorded on the span (status ERROR) and
 * re-thrown; the span always ends. Logs emitted inside `fn` carry this span's ids.
 */
export function withSpan<T>(
  name: string,
  options: { attributes?: Attributes; kind?: SpanKind },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: options.attributes, kind: options.kind }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: serializeError(err).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The active trace id, if tracing is on — returned to clients as a support reference. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

const USER_CONTENT_MODE = (process.env.LOG_USER_CONTENT || "preview").toLowerCase();
const PREVIEW_CHARS = 160;

/**
 * Customer-typed text, reduced per LOG_USER_CONTENT. Always reports the length so intent volume is
 * measurable even with content logging off.
 */
export function userText(text: string): { chars: number; text?: string; truncated?: boolean } {
  if (USER_CONTENT_MODE === "none") return { chars: text.length };
  if (USER_CONTENT_MODE === "full" || text.length <= PREVIEW_CHARS) return { chars: text.length, text };
  return { chars: text.length, text: `${text.slice(0, PREVIEW_CHARS)}…`, truncated: true };
}

export function elapsedMs(start: number) {
  return Math.round(performance.now() - start);
}
