# Travel Agent (demo)

A portfolio demo of **agentic AI patterns** — a travel-planning assistant that plans trips and
answers policy questions using tool use / function calling, in two forms:

| | What it is | Where |
|---|---|---|
| **CLI** | A single-file Python terminal chatbot | [`travel_agent.py`](travel_agent.py) |
| **Web** | The same agent embedded in a full "Aviana Travel" marketing site, deployed on Vercel | [`web/`](web/) |

Both share one knowledge base — [`knowledge_base/`](knowledge_base/) — used for the agentic RAG
tool described below.

## What it demonstrates

- **Tool use / function calling**: a multi-turn loop where the model decides, per turn, whether to
  ask a clarifying question, call a tool, or respond directly.
- **Multiple tools composed together**: `search_flights`, `search_hotels`, `get_weather`, and
  `search_knowledge_base`, synthesized into a day-by-day itinerary or a policy answer.
- **Honest mock vs. real data**: flights/hotels are clearly-labeled **mock data** (no paid travel
  API needed); weather is real, from the free [Open-Meteo](https://open-meteo.com/) API.
- **Agentic RAG**: `search_knowledge_base` is a tool the model calls *only when it decides a
  question needs it* (policy, fees, loyalty program, baggage) — not a fixed retrieve-then-generate
  pipeline, just another tool in the same tool-use loop. See [Agentic RAG](#agentic-rag-how-it-works)
  below.

---

## Quickstart: run the CLI locally

```bash
cd agent-demo
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.env.template config.env
# edit config.env and add your ANTHROPIC_API_KEY
python travel_agent.py
```

```
you> I want to plan a trip from Boston to Lisbon, roughly 5 days in early June, budget-conscious
agent> ...asks for exact dates if needed, then calls tools and proposes an itinerary...
```

Type `exit` or `quit` to end the session. To also enable `search_knowledge_base` (policy
questions), see [Agentic RAG](#agentic-rag-how-it-works).

## Quickstart: run the web app locally

```bash
cd agent-demo/web
cp .env.local.example .env.local   # fill in ANTHROPIC_API_KEY
npm install
npm run dev
```

Open `http://localhost:3000`. There's no login — the site is fully public, both locally and once
deployed (see [Note on cost exposure](#note-on-cost-exposure)).

---

## Deploying the web app to Vercel — step by step

This walks through setting up a brand-new deployment from scratch, including the parts that are
easy to get wrong (Root Directory, Blob storage, and where the required env vars actually come
from). If you're just running things locally, skip to [Agentic RAG](#agentic-rag-how-it-works).

### Step 1 — Prerequisites

- A [Vercel](https://vercel.com) account, connected to your GitHub account.
- An [Anthropic API key](https://console.anthropic.com/settings/keys).
- A free [Voyage AI](https://dash.voyageai.com/) API key (only needed for the knowledge-base tool
  — everything else works without it).
- (Optional) the [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`.

### Step 2 — Push this repo to GitHub

If you're starting from a local clone that isn't on GitHub yet:

```bash
cd agent-demo
git init                                      # if not already a repo
git remote add origin <your-empty-repo-url>
git add -A
git commit -m "Initial commit"
git push -u origin main
```

**Note the repo layout**: the repo root contains the CLI (`travel_agent.py`), the shared
`knowledge_base/`, *and* the `web/` Next.js app as a subfolder — not just the web app on its own.
That matters for the next step.

### Step 3 — Import the project into Vercel, with the correct Root Directory

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo you just pushed.
2. **Before clicking Deploy**, expand "Root Directory" in the import screen and set it to `web`.
   This tells Vercel the Next.js app lives in the `web/` subfolder, not the repo root. Framework
   Preset should auto-detect as **Next.js**.
3. Click **Deploy**.

> **If you forget this step**, the build fails with `Error: Couldn't find any pages or app
> directory` — because Vercel tries to build from the repo root, which has no Next.js app in it. To
> fix it after the fact: Project → **Settings → General → Root Directory**, set it to `web`, save,
> then redeploy. If you'd already run `vercel link` from inside `web/` before making this change,
> also move the project link so future CLI deploys run from the repo root instead:
> `mv web/.vercel .vercel` (run from the repo root).

This first deployment will succeed and the site (marketing pages, flight/hotel/weather planning)
will work — but `search_knowledge_base` won't have anything to search yet. That needs the next two
steps.

### Step 4 — Add the core environment variables

In the Vercel dashboard: Project → **Settings → Environment Variables**. Add these for both
**Production** and **Preview**:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_DEEP` | optional; default `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5` (the web app routes across these; `ANTHROPIC_MODEL` is CLI-only) |

### Step 5 — Create and connect a Vercel Blob store (for agentic RAG)

The knowledge-base tool needs somewhere to read its embedded documents from at request time. Since
Vercel serverless functions have no persistent disk, that's a Vercel Blob store, not a local file.

1. Project → **Storage** tab → **Create Database** → **Blob** → name it → **Create**.
2. When prompted, **connect it to this project for all environments** (Production, Preview,
   Development).
3. Connecting the store auto-adds `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY` to your project's
   env vars — **but not `BLOB_READ_WRITE_TOKEN` itself.** Go back to **Settings → Environment
   Variables**, find `BLOB_READ_WRITE_TOKEN`, reveal it, and if it isn't already listed for
   Production + Preview, add it explicitly with that value.
4. Also add `VOYAGE_API_KEY` (from Step 1) for Production + Preview — it's what embeds incoming
   queries at request time.

### Step 6 — Ingest the knowledge base

This step runs **locally**, not on Vercel — it chunks and embeds the docs in `knowledge_base/` and
uploads the result as a private blob.

```bash
cd agent-demo/web
cp .env.local.example .env.local
# fill in: ANTHROPIC_API_KEY, VOYAGE_API_KEY, BLOB_READ_WRITE_TOKEN
# (copy the same values you just set in the Vercel dashboard)
npm install
npm run ingest
```

You should see `Uploaded N chunks to private blob "knowledge-base.json"`. Re-run this any time you
edit `knowledge_base/` — it's safe to run repeatedly (it overwrites the same blob path).

### Step 7 — Redeploy

The first deployment (Step 3) ran before the Blob/Voyage env vars existed, so it doesn't have them.
Trigger a new deployment to pick them up:

```bash
cd agent-demo          # repo root, not web/ — see the Root Directory note in Step 3
vercel deploy --prod
```

...or just push any commit to `main`; with Root Directory correctly set to `web`, git-triggered
deploys work the same way from then on.

### Verify it worked

```bash
curl -s -X POST https://<your-deployment>.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[],"message":"What is your cancellation policy?"}'
```

The reply should quote Aviana's actual (fictional) cancellation policy, not a generic "I don't have
that information" response.

---

## Agentic RAG: how it works

`knowledge_base/` holds a fictional Aviana Travel policy doc (cancellation, loyalty program,
baggage, entry-document guidance, group bookings). Both the CLI and the web app expose a
`search_knowledge_base` tool that the model calls **at its own discretion** — when it judges a
question needs the actual policy text — and otherwise answers from general knowledge, saying so
explicitly. That's what makes it "agentic" RAG rather than a fixed retrieve-then-generate pipeline:
retrieval is just one more tool in the same tool-use loop as flights/hotels/weather.

The two surfaces use different storage, because they run in different environments:

- **CLI**: `python ingest.py` chunks and embeds `knowledge_base/` (via Voyage AI) into a local,
  persisted [Chroma](https://www.trychroma.com/) store at `.chroma_db/` (git-ignored). The CLI
  queries it directly on disk.
- **Web**: `npm run ingest` (in `web/`) does the same chunking/embedding, but uploads the result as
  one private JSON blob to **Vercel Blob** instead — Vercel serverless functions have no
  persistent disk, so there's no local vector store to query. At request time, `lib/knowledge.ts`
  reads that blob back, caches it in memory for the life of the serverless instance, and does
  brute-force cosine similarity against the query embedding. Simple and dependency-free — fine at
  this demo's scale (one curated doc, a few hundred chunks); would need a real vector index (e.g.
  Supabase pgvector) past that.

Add your own `.txt` / `.md` / `.pdf` files to `knowledge_base/` and re-run the relevant ingest
script to extend it. Without `VOYAGE_API_KEY` set, `search_knowledge_base` degrades gracefully on
both surfaces — it reports itself unavailable rather than breaking the rest of the agent.

There's intentionally no upload UI on the live site — the knowledge base is curated by whoever runs
the ingest script, not user-supplied, so a random visitor can't run up embedding costs.

## Troubleshooting

- **Build fails: `Couldn't find any pages or app directory`** — Root Directory isn't set to `web`.
  See Step 3 above.
- **`vercel deploy` fails: `The provided path ".../web/web" does not exist`** — you're running the
  CLI from inside `web/`, but the project's Root Directory is `web`, so the CLI expects to be run
  from the repo root with `.vercel/project.json` living there. Move it: `mv web/.vercel .vercel`
  (from the repo root), then always run `vercel deploy` from the repo root.
- **`search_knowledge_base` always says "unavailable" on the deployed site** — almost always a
  missing env var in Vercel: `BLOB_READ_WRITE_TOKEN` and `VOYAGE_API_KEY` are *not* added
  automatically just by connecting a Blob store (only `BLOB_STORE_ID`/`BLOB_WEBHOOK_PUBLIC_KEY`
  are). Check Settings → Environment Variables for both, for Production *and* Preview, then
  redeploy.
- **`npm run ingest` fails with "this blob already exists"** — only relevant if you're looking at
  old code; the current `scripts/ingest.mjs` passes `allowOverwrite: true` so re-running is safe.
- **Locally, `get()` 403s even though `BLOB_READ_WRITE_TOKEN` is correct** — if the repo is `vercel
  link`ed and the Vercel CLI is authenticated on your machine, `@vercel/blob` silently prefers a
  Vercel OIDC token over `BLOB_READ_WRITE_TOKEN` when both are available, and that OIDC token can
  403 unless the store is connected for the exact environment you're running in. `lib/knowledge.ts`
  and `scripts/ingest.mjs` both pass `token` explicitly to sidestep this entirely — if you're
  extending them, keep doing that rather than relying on default token resolution.

## Note on cost exposure

The web app has no authentication — `/api/chat` (and the Anthropic + Voyage API usage behind it) is
open to anyone with the deployed URL. That's a deliberate simplification for this demo; there is no
rate limiting or per-visitor cost cap.

## Where to look next

- [`CLAUDE.md`](CLAUDE.md) — CLI architecture notes for anyone (or any AI agent) editing
  `travel_agent.py` or `ingest.py`.
- [`web/README.md`](web/README.md) / [`web/CLAUDE.md`](web/CLAUDE.md) — web app architecture,
  file-by-file.
