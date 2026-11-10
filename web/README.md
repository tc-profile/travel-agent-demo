# Aviana Travel (web)

A "typical travel agent website" portfolio demo — Next.js + TypeScript, deployed on Vercel — built
around the same agentic pattern as the CLI version at `../travel_agent.py`, as a public site with
an AI trip-planning chat widget embedded on the homepage.

**No auth gate.** This was previously password-protected via a signed session cookie, but that's
been removed for demo convenience — `/api/chat` (and the Anthropic/Voyage API usage behind it) is
open to anyone who has the URL.

## Stack

- Next.js 16 (App Router, Turbopack), React 19, Tailwind CSS v4
- `@anthropic-ai/sdk` for the agent (tool use / function calling)
- No database, no auth

## Local development

```bash
cp .env.local.example .env.local   # fill in ANTHROPIC_API_KEY
npm install
npm run dev
```

To enable the knowledge-base tool, also fill in `VOYAGE_API_KEY` and `BLOB_READ_WRITE_TOKEN`, then
run `npm run ingest`. Without these, `search_knowledge_base` degrades gracefully — the agent just
reports the tool is unavailable and answers from general knowledge instead. For the full first-time
setup (creating the Blob store, wiring env vars in Vercel, etc.), see the
[repo-root README's deploy walkthrough](../README.md#deploying-the-web-app-to-vercel--step-by-step).

## Architecture

- `lib/tools.ts` — `searchFlights` / `searchHotels` return deterministic **mock** data (no paid
  travel API needed); `getWeather` calls the real, free Open-Meteo API, with a same-date-last-year
  fallback when the trip is too far out for a forecast. Ported from `travel_agent.py` — keep both in
  sync if the tool contracts change.
- `lib/weatherMcp.ts` — weather over **MCP**. `createWeatherMcpServer()` wraps `getWeather` as an
  MCP tool (`get_weather`, with an `outputSchema` / `structuredContent` result);
  `connectWeatherMcp()` is the agent's MCP client — it discovers tools via `tools/list` and runs
  Claude's calls via `tools/call`. Connects in-process (MCP in-memory transport) by default, or to
  a remote server over Streamable HTTP when `WEATHER_MCP_URL` is set.
- `app/api/mcp/route.ts` — the same weather MCP server published at `/api/mcp` (stateless
  Streamable HTTP), usable from any MCP client (e.g. MCP Inspector, Claude Desktop) or as
  `WEATHER_MCP_URL`. Unauthenticated, but only fronts the free Open-Meteo API.
- `lib/agent.ts` — system prompt, local tool schemas, and `runAgentTurn`, the tool-use loop (capped
  at `MAX_TOOL_ROUNDS` rounds so a pathological loop can't run away on API cost). Merges the MCP
  server's tools into the tool list each turn and collects weather results for the UI; if the MCP
  server can't be reached the agent keeps working without weather.
- `app/api/chat/route.ts` — receives `{ messages, message }` from the client, runs the agent loop
  server-side (so `ANTHROPIC_API_KEY` never reaches the browser), returns the updated transcript,
  the reply text, and any `weather` reports fetched over MCP that turn.
- `components/ChatWidget.tsx` — the embedded chat window on the homepage. Keeps the full Anthropic
  message transcript in client state and resends it each turn; the server does the actual agent
  work. Renders each MCP weather report as a card (`components/WeatherCard.tsx`) above
  the assistant's reply.
- `app/page.tsx` — the marketing site content (hero, destinations, features, testimonials) around
  the chat widget.

## Agentic RAG (knowledge base)

`search_knowledge_base` is a fourth tool, alongside flights/hotels/weather, that the agent calls
*when it decides a question needs it* — policy, fees, loyalty program, baggage, entry-document
guidance — rather than a fixed retrieve-then-generate pipeline. It's grounded in a fictional Aviana
policy doc at `../knowledge_base/`, shared with the CLI's copy of this same tool.

Because Vercel serverless functions have no persistent disk, this doesn't use an embedded vector
DB (that's what the CLI does with Chroma). Instead:

- `scripts/ingest.mjs` (run locally, not at request time) chunks the docs in `../knowledge_base/`,
  embeds them with Voyage AI, and uploads the result as one **private** JSON blob to Vercel Blob, at
  the fixed pathname `knowledge-base.json` — private means it has no public URL; only a request
  holding `BLOB_READ_WRITE_TOKEN` can read it.
- `lib/knowledge.ts` reads that blob back via `@vercel/blob`'s `get()` once per warm serverless
  instance, caches the parsed chunks in memory, and does brute-force cosine similarity against the
  query embedding. Simple and dependency-free — fine at this demo's scale (one curated doc, a few
  hundred chunks); would need a real vector index (e.g. Supabase pgvector) past that.

Re-run `npm run ingest` whenever `../knowledge_base/` changes — no other env var needs updating
since the blob path is fixed. There's no upload UI on the live site by design — the knowledge base
is curated, not user-supplied, so a random visitor can't run up embedding costs.

## Observability (logs + tracing)

Every chat request is traceable end to end, and every log line is structured JSON.

**Tracing (OpenTelemetry).** `instrumentation.ts` registers OpenTelemetry via `@vercel/otel`.
The chat widget starts a W3C `traceparent` per request, Next.js continues it, and the trace covers:

```
browser click (traceparent)
└─ POST /api/chat                          (Next.js root span; app.intent, app.outcome)
   └─ invoke_agent aviana-trip-planner     (gen_ai.* attrs, intent/outcome, token totals)
      ├─ mcp.connect aviana-weather        (transport: in_memory | streamable_http)
      ├─ chat <model>                      (one per Claude call: stop reason, token usage)
      │  └─ fetch POST api.anthropic.com
      └─ execute_tool <name>               (one per tool call; status ERROR on failure)
         └─ tools/call get_weather         (MCP server side — over HTTP this is under POST /api/mcp,
            └─ fetch GET open-meteo…        joined to the same trace via traceparent)
```

Span and attribute names follow the OpenTelemetry GenAI conventions (`gen_ai.operation.name`,
`gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.tool.name`, `gen_ai.conversation.id`).
`/api/chat` returns the trace id in an `x-trace-id` header and in the JSON body. When a request
fails, the widget shows a short `Ref:` code taken from it.

**Structured logs.** `lib/observability.ts` writes one JSON object per line, with `trace_id` /
`span_id` from the active span. Each log is also added as an event on that span. Key events:

| Event | Intent | Outcome |
|---|---|---|
| `agent.turn.started` | customer's message (per `LOG_USER_CONTENT`) | — |
| `tool.call.started` / `.completed` / `.failed` | tool + arguments the agent chose | `ok` / `error`, duration, result summary |
| `mcp.tool.completed` / `.failed` | server-side view of the same MCP call | `ok` / `error`, conditions, forecast vs estimate |
| `llm.call.completed` / `.failed` | round, tools requested | stop reason, tokens, duration, request id |
| `agent.turn.completed` / `.failed` | inferred intent (`trip_planning`, `policy_question`, `weather_lookup`, `general_conversation`) | `answered_with_tools`, `answered`, `clarifying_question`, `tool_limit_reached`, `refused`, `truncated`, `error`; plus `degraded` |
| `chat.request.received` / `.completed` / `.rejected` / `.failed` | — | HTTP status, reason, duration |

Intent is **inferred from the tools the agent chose**. This costs nothing extra, gives the same
answer every time, and reflects what the agent actually did. The customer's own words are logged
next to it as the stated intent.

**Environment variables** (all optional):

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS`) | Send spans to any OTLP/HTTP backend (Honeycomb, Grafana, Datadog, a local Jaeger at `http://localhost:4318`, …). On Vercel, a connected observability integration is used automatically. |
| `OTEL_TRACES_EXPORTER=console` | Print spans to the terminal (local debugging). |
| `OTEL_SERVICE_NAME` | Service name on spans and logs (default `aviana-travel-web`). |
| `LOG_LEVEL` | `debug` / `info` (default) / `warn` / `error`. |
| `LOG_USER_CONTENT` | How much customer-typed text appears in logs: `preview` (default, first 160 chars), `full`, or `none` (length only). |

Quick local look with Jaeger:
`docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.5.0`, then
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev` and open http://localhost:16686.

## Deployment

Deployed to the Vercel project `agent-demo` (team `timchowdary-3180s-projects`). For first-time
setup — creating the project with the correct Root Directory, wiring up Blob storage, and adding
env vars — see the [repo-root README's step-by-step guide](../README.md#deploying-the-web-app-to-vercel--step-by-step).
This section is just the day-to-day commands.

The Vercel project's **Root Directory is `web`**, and the repo root is `agent-demo/` (one level up
from here) — so `vercel` CLI commands must run from the repo root, with `.vercel/project.json`
living there too, not inside `web/`:

```bash
cd ..                  # repo root
vercel deploy          # preview
vercel deploy --prod   # production
```

Required environment variables (set in Vercel for both Production and Preview):
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (optional, defaults to `claude-sonnet-5`). For the
knowledge-base tool: `VOYAGE_API_KEY` and `BLOB_READ_WRITE_TOKEN`. **Connecting a Blob store only
auto-adds `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`** — `BLOB_READ_WRITE_TOKEN` itself has to be
copied in from Settings → Environment Variables separately.

**Note:** a brand-new Vercel project's very first-ever deployment always becomes the Production
deployment, regardless of the `--prod` flag — there's no "preview only" state before a production
exists. Every deployment after that first one respects `--prod` vs. plain `vercel deploy` normally.
