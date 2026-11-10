@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The web version of the `agent-demo` travel agent: a Next.js "typical travel agent website"
(Aviana Travel) with an embedded AI trip-planning chat widget. Sits alongside the CLI version at
`../travel_agent.py` — same agent behavior (mock flights/hotels, real Open-Meteo weather),
different surface. See `README.md` for the full architecture breakdown.

No auth gate — `/` and `/api/chat` are public. There used to be a shared-password session-cookie
gate (`proxy.ts` + `lib/auth.ts` + `app/login/`); it was removed by request for demo convenience.
That means `/api/chat`, and the Anthropic/Voyage spend behind it, is open to anyone with the URL.

## Commands

```bash
npm run dev     # dev server (Turbopack)
npm run build   # production build
npm run lint    # ESLint
npm run ingest  # embed ../knowledge_base/ docs and upload to Vercel Blob (needs .env.local)
vercel deploy         # preview deploy (after the first production deploy exists)
vercel deploy --prod  # production deploy
```

Deployed to the Vercel project `agent-demo` under team `timchowdary-3180s-projects`.

## Working in this repo

- Keep `lib/tools.ts` in sync with `../travel_agent.py`'s tool contracts if either changes — same
  mock-data shape and the same Open-Meteo fallback logic. Same for `lib/knowledge.ts` and
  `../ingest.py`'s chunking (size/overlap) if either changes.
- Agentic RAG: `search_knowledge_base` (in `lib/knowledge.ts`, wired into `lib/agent.ts`) is a
  fourth tool the agent calls at its own discretion — not a fixed retrieve-then-generate pipeline.
  It reads a precomputed embeddings JSON blob from Vercel Blob (private access, fixed pathname
  `knowledge-base.json`, read via `@vercel/blob`'s `get()`) rather than using a vector DB, since
  Vercel serverless functions have no persistent disk. Needs `@vercel/blob` ^2.x — the `access:
  'private'` option doesn't exist before that. Re-run `npm run ingest` after editing
  `../knowledge_base/` (its `put()` uses `allowOverwrite: true` since the pathname is fixed —
  without it, re-ingesting 400s on the second run). There is intentionally no live upload UI on the
  site (curated content only, to bound embedding cost). See `README.md`'s "Agentic RAG" section.
- Always pass `token` explicitly to `@vercel/blob` calls (both `put()` in `scripts/ingest.mjs` and
  `get()` in `lib/knowledge.ts`) rather than relying on default resolution. In a `vercel link`-ed
  repo with an authenticated CLI, the SDK silently prefers a Vercel OIDC token over
  `BLOB_READ_WRITE_TOKEN` when both are available — and that OIDC token 403s unless the store is
  explicitly connected for the current environment, which fails silently (caught, returns `[]`)
  unless you're watching for the `console.warn` in `lib/knowledge.ts`.
- `get_weather` is served by an MCP server (`lib/weatherMcp.ts`, also exposed at `/api/mcp`), not
  defined in `lib/agent.ts`'s `TOOLS` — the agent discovers it via MCP `tools/list` each turn. Its
  result shape (`weatherReportSchema`) is what `components/WeatherCard.tsx` renders; keep it in
  sync with `getWeather` in `lib/tools.ts` and `get_weather` in `../travel_agent.py`. Optional
  `WEATHER_MCP_URL` switches the agent from the in-process MCP transport to Streamable HTTP.
- Long conversations use server-side compaction (`lib/compaction.ts`, beta `compact-2026-01-12`), so
  Claude calls go through `client.beta.messages.create` with `Anthropic.Beta.*` message types.
  Round-trip `compaction` blocks byte-for-byte (they carry opaque `encrypted_content`), and trim
  only before a block whose `content` is non-null. Don't reintroduce a small message-count cap in
  `/api/chat`; that would block chats long before compaction could trigger.
- Observability: log through `logger` from `lib/observability.ts` (one JSON line per event,
  auto-stamped with `trace_id`/`span_id`) — not `console.*`. Name events `<area>.<thing>.<verb>`
  and put `intent` (what was attempted) and `outcome` (how it ended) on the events that matter.
  Wrap meaningful units of work in `withSpan(...)`; customer-typed text goes through `userText()`
  so `LOG_USER_CONTENT` is respected. Tracing is registered in `instrumentation.ts`; see
  `README.md`'s "Observability" section.
- `.env.local` and `.env*` are git-ignored; never commit real secrets. `.env.local.example` is the
  checked-in reference.
