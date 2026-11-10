# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A portfolio demo of an agentic AI pattern: a single-file Python CLI (`travel_agent.py`) that uses the Anthropic Claude API's tool use (function calling) to plan a trip through multi-turn conversation.

The CLI is a single agent. The web version runs a multi-agent system: a router, specialists, model-tier routing, guardrails, and self-evaluation (`web/lib/agents/`).

There's also a web version in `web/` — a full "Aviana Travel" website (Next.js, deployed on Vercel) with a password-gated homepage and the same agent embedded as a chat widget. See `web/CLAUDE.md` and `web/README.md` for that side; keep `web/lib/tools.ts` in sync with this file's tool contracts if either changes. On the web side, `get_weather` is served to the agent through an MCP server (`web/lib/weatherMcp.ts`, also public at `/api/mcp`) and rendered as weather cards in the chat widget.

## Commands

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.env.template config.env   # then fill in ANTHROPIC_API_KEY (and VOYAGE_API_KEY for RAG)
python ingest.py                    # optional: embed knowledge_base/ for search_knowledge_base
python travel_agent.py
```

No build step, lint config, or test suite — this is a demo script, not a package.

## Architecture

- `travel_agent.py` — everything lives here:
  - `SYSTEM_PROMPT` / `TOOLS` — the agent's instructions and tool schemas passed to the Messages API.
  - `search_flights` / `search_hotels` — return deterministic **mock** data (seeded by query, via `_seeded_rng`), explicitly labeled as mock in their return payload. No paid travel API is used.
  - `get_weather` — calls the real, free [Open-Meteo](https://open-meteo.com/) API: live forecast for dates within ~16 days, otherwise falls back to actual historical weather from the same date one year prior (labeled as an estimate in the response).
  - `search_knowledge_base` — agentic RAG: the model decides when a question needs Aviana's own reference docs (policy, loyalty program, baggage, entry-document guidance) rather than always retrieving. Embeds the query with Voyage AI and queries a local, persisted Chroma collection built by `ingest.py`.
  - `run_agent_turn` — the agentic loop: calls the model, and while `stop_reason == "tool_use"`, executes the requested tool(s) locally and feeds `tool_result` blocks back, until the model returns a final text reply.
  - `main` — a plain `input()`/`print()` REPL; exits cleanly with setup instructions if `ANTHROPIC_API_KEY` is unset.
- `ingest.py` — chunks and embeds every `.txt`/`.md`/`.pdf` file in `knowledge_base/` (Voyage AI embeddings) into a local Chroma store at `.chroma_db/` (git-ignored). Re-run after editing `knowledge_base/`. `knowledge_base/` is shared with the web version's own ingestion script (`web/scripts/ingest.mjs`) — same source docs, two different vector backends because the web app runs on Vercel serverless (no persistent disk).
- Model defaults to `claude-sonnet-5`, overridable via `ANTHROPIC_MODEL` in `config.env`.

## Working in this repo

- Keep flight/hotel results clearly labeled as mock — this agent cannot make real bookings, and the system prompt tells the model to say so if asked.
- If adding a new tool, register it in both `TOOLS` (schema for the API) and `TOOL_FUNCTIONS` (the dispatch dict `run_agent_turn` calls into) — both must stay in sync.
- Keep `knowledge_base/`, `ingest.py`'s chunking (size/overlap, embedding model), and `search_knowledge_base`'s tool contract in sync with the web version's `web/lib/knowledge.ts` and `web/scripts/ingest.mjs` if any change.
- `config.env` is git-ignored; never commit real API keys. `config.env.template` is the checked-in reference. Without `VOYAGE_API_KEY` set, `search_knowledge_base` degrades gracefully (reports itself unavailable) rather than breaking the rest of the agent.
