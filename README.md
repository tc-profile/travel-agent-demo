# Travel Agent (demo)

A small portfolio demo of an agentic AI pattern: a conversational CLI agent
that uses **tool use / function calling** to plan a trip.

## What it demonstrates

- A multi-turn conversation loop where the model decides, per turn, whether
  to ask a clarifying question, call a tool, or respond directly.
- Multiple tools composed together: the model calls `search_flights`,
  `search_hotels`, and `get_weather` as needed, then synthesizes the
  results into a day-by-day itinerary.
- Mixing mock and real data honestly: flight and hotel results are clearly
  labeled **mock data** (no paid travel API required for this demo), while
  weather comes from the real, free [Open-Meteo](https://open-meteo.com/)
  API — with a graceful fallback to last year's actual weather on the same
  date when the trip is too far out for a forecast.
- **Agentic RAG**: a `search_knowledge_base` tool that the model calls only
  when it decides a question needs Aviana's own reference documents
  (booking/cancellation policy, loyalty program, baggage rules, entry-
  document guidance) — not a fixed retrieve-then-generate pipeline, just
  another tool in the same tool-use loop.

## Setup

```bash
cd agent-demo
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.env.template config.env
# edit config.env and add your ANTHROPIC_API_KEY (and VOYAGE_API_KEY for RAG)
```

## Run

```bash
python travel_agent.py
```

Example:
```
you> I want to plan a trip from Boston to Lisbon, roughly 5 days in early June, budget-conscious
agent> ...asks for exact dates if needed, then calls tools and proposes an itinerary...
```

Type `exit` or `quit` to end the session.

## Notes

- Flight and hotel data is deterministic mock data (seeded by your query),
  clearly labeled as such — this agent cannot make real bookings.
- Weather is real for dates within ~16 days; for dates further out, it
  substitutes actual weather from the same date last year and says so.

## Agentic RAG (knowledge base)

`knowledge_base/` holds a fictional Aviana Travel policy doc. To make it
searchable:

```bash
cp config.env.template config.env   # if you haven't already
# add VOYAGE_API_KEY (free tier: https://dash.voyageai.com/)
python ingest.py                    # chunks + embeds knowledge_base/ into .chroma_db/
```

Then ask the agent something like *"What's your cancellation policy?"* or
*"How does the loyalty program work?"* — it'll call `search_knowledge_base`
and answer from the retrieved passages, falling back to general knowledge
(and saying so) for anything the docs don't cover.

Add your own `.txt` / `.md` / `.pdf` files to `knowledge_base/` and re-run
`python ingest.py` to extend it. Without `VOYAGE_API_KEY` set, this tool
just reports itself unavailable — everything else still works.

The web version (`web/`) uses the same `knowledge_base/` docs but a
different storage backend, since Vercel serverless functions can't persist
a local Chroma DB — see `web/README.md`'s "Agentic RAG" section.
