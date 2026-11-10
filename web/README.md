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
- `lib/agents/` — the multi-agent system (see "Multi-agent architecture" below). `lib/agent.ts`
  re-exports its entry point, `runAgentTurn`.
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

## Multi-agent architecture

The single tool-using agent is now a team of agents in `lib/agents/`, coordinated per turn by
`orchestrator.ts`:

```
customer message
 └─ input guardrails (rules: size cap, card-number redaction, injection heuristics)
     └─ router — Haiku 5.5, structured JSON: safety verdict, intent, complexity, 1–3 tasks
         ├─ unsafe / prompt_injection → canned reply (no specialist runs)
         └─ specialists, in parallel, each on the tier the routing table picks
              trip_planner (flights, hotels, weather) · policy_expert (knowledge base)
              weather_specialist (weather) · concierge (no tools)
             └─ synthesizer — merges answers when more than one specialist ran
                 └─ output guardrails (rules) → evaluator (judge model, rubric, JSON scores)
                     └─ on fail: one revision with the judge's feedback, escalated a tier
                        when any score ≤ 2 → final guardrail check → reply
```

**Strategic model routing** (`models.ts`). The router classifies; code picks the model, so routing
is cheap, deterministic, auditable, and easy to change:

| Agent | simple | standard | complex |
|---|---|---|---|
| trip_planner | Sonnet 5.5 · low | Sonnet 5.5 · medium | **Opus 5.5** · medium |
| policy_expert | Haiku 5.5 · medium | Sonnet 5.5 · low | Sonnet 5.5 · medium |
| weather_specialist | Haiku 5.5 · low | Haiku 5.5 · medium | Sonnet 5.5 · low |
| concierge | Haiku 5.5 · low | Haiku 5.5 · low | Haiku 5.5 · medium |
| router | Haiku 5.5 · low (always) | | |
| synthesizer | Sonnet 5.5 · low (Opus 5.5 when escalated) | | |
| evaluator | Sonnet 5.5 · medium; Opus 5.5 when judging Opus output | | |

Tiers are set by `MODEL_FAST` (default `claude-haiku-5-5`), `MODEL_BALANCED` (`claude-sonnet-5-5`)
and `MODEL_DEEP` (`claude-opus-5-5`). Sonnet and Opus requests carry a server-side **refusal
fallback** to `claude-opus-4-8` (beta `server-side-fallback-2026-06-01`; `REFUSAL_FALLBACKS=off` to
disable, `REFUSAL_FALLBACK_MODEL` to change). Haiku has no server-side fallback. Every turn logs a
per-model token and estimated-cost ledger (`agent.turn.completed` → `cost`).

**Guardrails** (`guardrails.ts`). These are rules, not model calls, so they can't be talked around:

- **Input:** messages over 4,000 characters are refused. Luhn-valid card numbers are redacted before
  any model sees them, and the reply adds a notice. Prompt-injection patterns are passed to the
  router as signals, and the router makes the call.
- **Tool:** each specialist may call only its allowlisted tools. Arguments are validated (real
  dates, no past flight or check-in dates, checkout after checkin, at most 30 nights, sane
  `top_k`). A blocked call comes back as an error result, so the agent corrects itself.
- **Output:** checks for booking or confirmation claims, flight numbers or hotel names that no tool
  returned, a booking request answered without the mock-data disclosure, and card numbers in the
  reply. A "block" finding that survives revision replaces the reply with a safe fallback.
- **History:** the browser-held transcript is reduced to customer text, assistant text, and
  compaction summaries (`history.ts`). Forged tool results, thinking blocks, or system messages are
  dropped.

**Self-evaluation** (`evaluator.ts`). The judge scores each draft from 1 to 5 on whether it
addresses the request, is grounded in tool evidence, makes honest disclosures (mock data, weather
estimates, sources), is safe, and is clear. It sees the tool evidence and the guardrail findings.
Pass means verdict `pass`, every score ≥ 3, and no blocking finding. Otherwise the draft is revised
once: the specialist continues its own transcript with the feedback, or the synthesizer re-merges.
The revision moves up a tier when a score is ≤ 2. `EVAL_MODE=auto` (default) reviews trip-planner
and policy answers plus anything a guardrail flagged; `always` / `off` are also available.
`EVAL_MAX_REVISIONS` defaults to 1 (max 2).

**Why the shared history is text-only.** Each specialist's tool calls and thinking stay inside its
own run on one model. The conversation the browser stores holds only text and compaction summaries,
so routing later turns to a different model never replays one model's thinking or tool blocks into
another. Compaction still applies: when a specialist's request compacts, the history restarts at
that summary. The tradeoff is that raw tool payloads from earlier turns aren't kept; their substance
survives through the replies and summaries.

The widget's caption under each reply shows who answered and how it was checked, e.g.
`Trip Planner · Opus 5.5 + Policy Expert · Sonnet 5.5 · revised after review`.

## Long conversations (context compaction)

Long chats are handled by the Claude API's **server-side compaction** (beta `compact-2026-01-12`),
configured in `lib/compaction.ts`:

- Every Claude call in the agent loop sends a `compact_20260112` edit. When the input reaches
  `COMPACTION_TRIGGER_TOKENS` (default **50,000**, the API minimum), the API summarizes the earlier
  conversation into a `compaction` block and answers from that summary. Custom summary
  instructions make it keep what a trip planner needs: trip details, dates, budget, preferences,
  chosen and rejected flights and hotels, weather findings, the itinerary draft, and open questions.
- After a successful compaction, the agent drops every message before the summary
  (`trimToLatestCompaction`). It keeps the compaction block exactly as returned, since it carries
  opaque `encrypted_content`. The transcript returned to the browser, and re-sent on the next turn,
  therefore stays small however long the chat runs. A failed compaction (`content: null`) trims
  nothing.
- The customer still sees the whole chat. The widget adds a small "Earlier messages were
  summarized…" divider at the point where the model's context was summarized.
- Requests also use top-level prompt caching (`cache_control: {type: "ephemeral"}`), so each tool
  round and each turn re-reads the growing history from cache.
- The old 60-message cap is gone. `/api/chat` now only rejects payloads far larger than a compacted
  transcript can reach (400 messages or about 1.5 MB).
- Observability: a `context.compacted` log (or `context.compaction.failed`) records context tokens
  summarized, summary tokens, and messages dropped. Turn logs report `compactions` and the
  summarizer's cost as `compaction_input_tokens` / `compaction_output_tokens`, because the API
  reports that cost only in `usage.iterations`, not in the top-level usage.

Raising `COMPACTION_TRIGGER_TOKENS` keeps more verbatim history before summarizing. The cost is that
every request reads more input tokens.

## Testing

**Offline regression suite (`npm test`).** Vitest; runs in under a second with no network, no API
keys, and a fixed clock (2026-11-10). Claude is replaced by a scripted fake that answers per agent,
Open-Meteo by a `fetch` stub. Everything else is the real code.

| Area | File | What it pins down |
|---|---|---|
| Guardrails | `tests/unit/guardrails.test.ts` | card redaction (Luhn), injection signals, tool allowlists + argument validation, output findings |
| History & compaction | `tests/unit/history-compaction.test.ts` | text-only sanitization, forged-block stripping, summary round-trip, trigger clamping |
| Models & routing | `tests/unit/models.test.ts` | the golden routing table, escalation, request shape (betas, fallbacks, caching, effort), cost ledger |
| Tools | `tests/unit/tools.test.ts` | mock-data determinism + snapshots, forecast/estimate boundary, error payloads |
| Observability | `tests/unit/observability.test.ts` | JSON log envelope, levels, `LOG_USER_CONTENT` modes, error serialization |
| MCP | `tests/integration/weatherMcp.test.ts` | in-memory MCP session, `/api/mcp` JSON-RPC (initialize, tools/list, tools/call) |
| Orchestrator | `tests/integration/orchestrator.test.ts` | end-to-end scenarios: routing tiers, fan-out + synthesis, blocked tools, tool limit, injection, card redaction, forged history, review/revision/escalation, safe fallback, refusals, compaction, log contract |
| Chat API | `tests/integration/chatRoute.test.ts` | `/api/chat` response shape, history round-trip, 400/413/500 paths, no leaked internals |
| CLI parity | `tests/contract/cliParity.test.ts` | the web agents and `../travel_agent.py` expose identical tool contracts and weather labels (skipped without python3) |

**Live regression eval (`npm run eval`, opt-in, billed).** Runs the golden customer cases in
`evals/cases.ts` against the real Claude API and real Open-Meteo. Each case checks behavior
(routing, tools called, outcome, guardrails, reply properties), not exact wording. Universal
invariants are also checked: non-empty reply, no blocking guardrail finding, text-only history,
and cost per case under `EVAL_MAX_COST_USD` (default $0.50). It reads `ANTHROPIC_API_KEY` from
`.env.local` or the shell, and skips itself without one. A JSON report goes to `evals/results/`;
`EVAL_UPDATE_BASELINE=1` records `evals/baseline.json`, and later runs list cases that regressed
against it. `EVAL_CASES=greeting,policy-question` runs a subset. Expect roughly $0.30–$1 per full
run of 12 cases, depending on routing and revisions; each case's estimated cost is in the report.

**CLI** (`pytest` from the repo root, after `pip install -r requirements-dev.txt`): tool registry
sync, mock data, weather branches (faked network and clock), knowledge-base degradation, the
agent loop, and the missing-key exit.

CI (`.github/workflows/tests.yml`) runs the CLI tests plus the web lint, typecheck, and offline
suite on every push and PR. The live eval is never run in CI.

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
| `context.compacted` / `context.compaction.failed` | summarize history at the trigger threshold | `summarized` / `no_summary`, tokens summarized, messages dropped |
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
`ANTHROPIC_API_KEY`; optionally `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_DEEP` (see "Multi-agent
architecture"; `ANTHROPIC_MODEL` is CLI-only and ignored by the web app). For the
knowledge-base tool: `VOYAGE_API_KEY` and `BLOB_READ_WRITE_TOKEN`. **Connecting a Blob store only
auto-adds `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`** — `BLOB_READ_WRITE_TOKEN` itself has to be
copied in from Settings → Environment Variables separately.

**Note:** a brand-new Vercel project's very first-ever deployment always becomes the Production
deployment, regardless of the `--prod` flag — there's no "preview only" state before a production
exists. Every deployment after that first one respects `--prod` vs. plain `vercel deploy` normally.
