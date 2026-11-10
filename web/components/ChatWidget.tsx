"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { WeatherReport } from "@/lib/weatherMcp";
import { OPEN_CHAT_EVENT } from "./chatWidgetEvents";
import WeatherCard from "./WeatherCard";

/** Which agents answered, on which models, and whether the answer passed self-review. */
type AgentMeta = { agents: { name: string; model: string }[]; review: string; escalated: boolean };

const REVIEW_LABEL: Record<string, string> = {
  passed: "self-checked ✓",
  revised: "revised after review",
  fallback_reply: "held back by guardrails",
};

type DisplayMessage =
  | { role: "user" | "assistant"; text: string; weather?: WeatherReport[]; meta?: AgentMeta }
  | { role: "notice"; text: string };

/** Random lowercase hex string of `bytes` bytes. */
function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * W3C trace context header that starts a new trace in the browser for each chat request. The
 * server (Next.js) continues it, so the whole request — route, agent loop, Claude calls, MCP tool
 * calls — shares this trace id end to end.
 */
function newTraceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

const SUGGESTIONS = [
  "5 days in Lisbon this June, mid-range budget",
  "Weekend trip from NYC to Montreal in October",
  "2 weeks backpacking Southeast Asia in the fall",
  "What's your cancellation and baggage policy?",
];

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  // Full Anthropic message history (opaque to this component) — resent each turn so the
  // server-side agent loop has full context, mirroring the CLI version's conversation state.
  const [transcript, setTranscript] = useState<unknown[]>([]);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Groups every turn of this chat in logs/traces (gen_ai.conversation.id). Not tied to identity.
  const conversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    const openChat = () => setOpen(true);
    window.addEventListener(OPEN_CHAT_EVENT, openChat);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, openChat);
  }, []);

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [displayMessages, loading, open]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setInput("");
    setError(null);
    setDisplayMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setLoading(true);

    try {
      conversationIdRef.current ??= crypto.randomUUID();
      const traceparent = newTraceparent();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          traceparent,
          "x-conversation-id": conversationIdRef.current,
        },
        body: JSON.stringify({ messages: transcript, message: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Short support reference: the trace id lets the team find this exact request in logs.
        const ref = (data.traceId ?? traceparent.split("-")[1]).slice(0, 12);
        throw new Error(`${data.error || "Something went wrong."} (Ref: ${ref})`);
      }

      // After a compaction the server returns a transcript that starts at the summary — keep that
      // (smaller) copy; the on-screen chat history below is untouched.
      setTranscript(data.messages);
      setDisplayMessages((prev) => [
        ...prev,
        ...(data.compacted
          ? [{ role: "notice" as const, text: "Earlier messages were summarized so we can keep planning — your trip details are kept." }]
          : []),
        {
          role: "assistant",
          text: data.reply,
          weather: Array.isArray(data.weather) ? data.weather : [],
          meta: data.meta,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3 sm:bottom-6 sm:right-6">
      {open && (
        <div className="flex h-[min(70vh,560px)] w-[92vw] max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_25px_60px_-30px_rgba(31,42,46,0.45)]">
          <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                ✦
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Aviana AI Trip Planner</p>
                <p className="text-xs text-muted">Mock flights &amp; hotels, real weather — demo only</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close trip planner"
              className="shrink-0 rounded-full p-1.5 text-muted transition hover:bg-background hover:text-foreground"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {displayMessages.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  Tell me where you&apos;d like to go and I&apos;ll put together an itinerary.
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => sendMessage(s)}
                      className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground/80 transition hover:border-primary hover:text-primary"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {displayMessages.map((m, i) =>
              m.role === "notice" ? (
                <div key={i} role="status" className="flex items-center gap-3 text-[11px] text-muted">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-center">{m.text}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : (
              <div
                key={i}
                className={`flex flex-col gap-2 ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                {m.weather && m.weather.length > 0 && (
                  <div className="w-full max-w-[85%] space-y-2" aria-label="Weather details">
                    {m.weather.map((w, j) => (
                      <WeatherCard key={`${w.location}-${w.date}-${j}`} report={w} />
                    ))}
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-foreground [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-1.5 [&_strong]:font-semibold"
                  }`}
                >
                  {m.role === "assistant" ? <ReactMarkdown>{m.text}</ReactMarkdown> : m.text}
                </div>
                {m.role === "assistant" && m.meta?.agents?.length ? (
                  <p className="max-w-[85%] px-1 text-[10px] text-muted">
                    {m.meta.agents.map((a) => `${a.name} · ${a.model}`).join(" + ")}
                    {m.meta.escalated ? " · escalated" : ""}
                    {REVIEW_LABEL[m.meta.review] ? ` · ${REVIEW_LABEL[m.meta.review]}` : ""}
                  </p>
                ) : null}
              </div>
              )
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-background px-4 py-2.5 text-sm text-muted">Planning…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {error && <p className="px-5 text-xs text-red-600">{error}</p>}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="flex items-center gap-2 border-t border-border p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. 5 days in Lisbon this June"
              disabled={loading}
              className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              Send
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close trip planner" : "Open trip planner"}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-xl text-primary-foreground shadow-[0_20px_40px_-15px_rgba(31,42,46,0.5)] transition hover:opacity-90"
      >
        {open ? "✕" : "✦"}
      </button>
    </div>
  );
}
