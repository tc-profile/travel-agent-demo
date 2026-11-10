"""
Travel Agent — a portfolio demo of an agentic AI pattern using tool use.

Run:
    python travel_agent.py

The agent gathers trip details through conversation (origin, destination,
dates, budget, preferences), then calls tools to gather information and
proposes a day-by-day itinerary.

Tools:
    - search_flights / search_hotels return MOCK data (clearly labeled) so
      this demo needs no paid travel API keys.
    - get_weather calls the real, free Open-Meteo API. If the trip date is
      too far out for a forecast, it falls back to last year's actual
      weather for that date as an estimate.
"""

import hashlib
import json
import os
import sys
from datetime import date, datetime, timedelta

import chromadb
import requests
import voyageai
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "config.env"))

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
VOYAGE_MODEL = "voyage-3.5-lite"
CHROMA_DIR = os.path.join(os.path.dirname(__file__), ".chroma_db")
KB_COLLECTION_NAME = "knowledge_base"

SYSTEM_PROMPT = """You are a travel planning assistant demo.

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
estimate based on the same date last year — say so when you use it).

You also have access to search_knowledge_base, which searches Aviana's own
reference documents (booking/cancellation policy, loyalty program, baggage
rules, entry-document guidance, group bookings). Call it when a question
might be answered by that material — policy, fees, loyalty program, baggage,
documents — rather than guessing. If it returns no useful match, fall back
to your general knowledge and say the answer isn't from Aviana's documents.

Keep responses concise and skimmable: short paragraphs, bullet points for
options and itinerary days.
"""

TOOLS = [
    {
        "name": "search_flights",
        "description": (
            "Search for flights between two cities on a given date. Returns "
            "MOCK data for demo purposes, not real bookable flights."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "origin": {"type": "string", "description": "Origin city or airport"},
                "destination": {"type": "string", "description": "Destination city or airport"},
                "date": {"type": "string", "description": "Departure date, YYYY-MM-DD"},
            },
            "required": ["origin", "destination", "date"],
        },
    },
    {
        "name": "search_hotels",
        "description": (
            "Search for hotels in a destination city for a date range. "
            "Returns MOCK data for demo purposes, not real bookable hotels."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "destination": {"type": "string", "description": "Destination city"},
                "checkin": {"type": "string", "description": "Check-in date, YYYY-MM-DD"},
                "checkout": {"type": "string", "description": "Check-out date, YYYY-MM-DD"},
                "max_price_per_night": {
                    "type": "number",
                    "description": "Optional budget ceiling per night, in USD",
                },
            },
            "required": ["destination", "checkin", "checkout"],
        },
    },
    {
        "name": "get_weather",
        "description": (
            "Get real weather for a destination on a given date, via Open-Meteo. "
            "Uses a live forecast if the date is within ~16 days; otherwise falls "
            "back to actual weather from the same date last year as an estimate."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "destination": {"type": "string", "description": "Destination city"},
                "date": {"type": "string", "description": "Date, YYYY-MM-DD"},
            },
            "required": ["destination", "date"],
        },
    },
    {
        "name": "search_knowledge_base",
        "description": (
            "Search Aviana's own reference documents — booking/cancellation policy, "
            "loyalty program, baggage rules, entry-document guidance, group bookings, "
            "customer support — for a relevant passage. Use for policy/fee/program "
            "questions instead of guessing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for"},
                "top_k": {
                    "type": "integer",
                    "description": "Number of matching passages to return (default 4)",
                },
            },
            "required": ["query"],
        },
    },
]


# ---------------------------------------------------------------------------
# Mock data helpers
# ---------------------------------------------------------------------------

_AIRLINES = {
    "Aegis Air": "AX", "Blue Horizon": "BH", "Meridian": "MR",
    "Skyline Express": "SX", "NorthWing": "NW",
}
_HOTEL_NAMES = [
    "The Wren Hotel", "Harborview Inn", "Cobalt Suites", "The Linden House",
    "Aster & Pine", "Northgate Residency",
]


def _seeded_rng(*parts):
    """Deterministic pseudo-randomness so the same query returns the same mock results."""
    seed = int(hashlib.sha256("|".join(parts).encode()).hexdigest(), 16)
    import random
    return random.Random(seed)


def search_flights(origin, destination, date_str):
    rng = _seeded_rng("flights", origin.lower(), destination.lower(), date_str)
    flights = []
    for i in range(3):
        depart_hour = rng.randint(5, 21)
        duration_hours = rng.randint(2, 11)
        airline = rng.choice(list(_AIRLINES))
        flights.append({
            "airline": airline,
            "flight_number": f"{_AIRLINES[airline]}{rng.randint(100, 999)}",
            "departs": f"{date_str} {depart_hour:02d}:{rng.choice(['00', '15', '30', '45'])}",
            "duration_hours": duration_hours,
            "stops": rng.choice([0, 0, 1]),
            "price_usd": rng.randint(180, 1400),
        })
    return {"note": "MOCK data for demo purposes — not real bookable flights.", "results": flights}


def search_hotels(destination, checkin, checkout, max_price_per_night=None):
    rng = _seeded_rng("hotels", destination.lower(), checkin, checkout)
    hotels = []
    for name in rng.sample(_HOTEL_NAMES, k=3):
        price = rng.randint(80, 450)
        hotels.append({
            "name": name,
            "rating": round(rng.uniform(3.4, 4.9), 1),
            "price_per_night_usd": price,
            "area": rng.choice(["City Center", "Old Town", "Waterfront", "Business District"]),
        })
    if max_price_per_night:
        hotels = [h for h in hotels if h["price_per_night_usd"] <= max_price_per_night] or hotels
    return {"note": "MOCK data for demo purposes — not real bookable hotels.", "results": hotels}


# ---------------------------------------------------------------------------
# Real weather tool (Open-Meteo, no API key required)
# ---------------------------------------------------------------------------

# WMO weather interpretation codes (Open-Meteo's `weather_code`) -> short label.
# Keep in sync with WMO_CONDITIONS in web/lib/tools.ts.
_WMO_CONDITIONS = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
}


def _geocode(place):
    resp = requests.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        params={"name": place, "count": 1},
        timeout=10,
    )
    resp.raise_for_status()
    results = resp.json().get("results")
    if not results:
        return None
    r = results[0]
    return r["latitude"], r["longitude"], r.get("name", place), r.get("country", "")


def get_weather(destination, date_str):
    geo = _geocode(destination)
    if not geo:
        return {"error": f"Could not find location '{destination}'."}
    lat, lon, resolved_name, country = geo

    try:
        target = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return {"error": f"Invalid date '{date_str}', expected YYYY-MM-DD."}

    days_out = (target - date.today()).days

    if 0 <= days_out <= 15:
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon,
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
                "timezone": "auto",
                "start_date": date_str, "end_date": date_str,
            },
            timeout=10,
        )
        source = "live forecast"
    else:
        # Too far out for a forecast — use the same date last year as an estimate.
        estimate_date = target.replace(year=target.year - 1)
        resp = requests.get(
            "https://archive-api.open-meteo.com/v1/archive",
            params={
                "latitude": lat, "longitude": lon,
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
                "timezone": "auto",
                "start_date": estimate_date.isoformat(), "end_date": estimate_date.isoformat(),
            },
            timeout=10,
        )
        source = f"estimate based on actual weather on {estimate_date.isoformat()} (forecast unavailable this far out)"

    resp.raise_for_status()
    daily = resp.json().get("daily")
    if not daily or not daily.get("time"):
        return {"error": "No weather data available for that date/location."}

    code = (daily.get("weather_code") or [None])[0]
    return {
        "location": f"{resolved_name}, {country}",
        "date": date_str,
        "source": source,
        "weather_code": code,
        "conditions": _WMO_CONDITIONS.get(code, "Unknown"),
        "temp_max_c": daily["temperature_2m_max"][0],
        "temp_min_c": daily["temperature_2m_min"][0],
        "precipitation_mm": daily["precipitation_sum"][0],
    }


# ---------------------------------------------------------------------------
# Agentic RAG: knowledge base search (Voyage embeddings + local Chroma store)
# ---------------------------------------------------------------------------

_kb_collection = None  # lazily loaded; False once we've confirmed it's absent
_voyage_client = None


def _get_knowledge_collection():
    global _kb_collection
    if _kb_collection is None:
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        try:
            _kb_collection = client.get_collection(KB_COLLECTION_NAME)
        except Exception:
            _kb_collection = False
    return _kb_collection or None


def search_knowledge_base(query, top_k=4):
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        return {"error": "VOYAGE_API_KEY is not set — knowledge base search is unavailable."}

    collection = _get_knowledge_collection()
    if collection is None:
        return {"error": "No knowledge base has been ingested yet. Run `python ingest.py`."}

    global _voyage_client
    if _voyage_client is None:
        _voyage_client = voyageai.Client(api_key=api_key)
    query_embedding = _voyage_client.embed([query], model=VOYAGE_MODEL, input_type="query").embeddings[0]

    results = collection.query(query_embeddings=[query_embedding], n_results=top_k or 4)
    matches = [
        {"source": meta["source"], "text": doc}
        for doc, meta in zip(results["documents"][0], results["metadatas"][0])
    ]
    return {"matches": matches}


TOOL_FUNCTIONS = {
    "search_flights": lambda i: search_flights(i["origin"], i["destination"], i["date"]),
    "search_hotels": lambda i: search_hotels(
        i["destination"], i["checkin"], i["checkout"], i.get("max_price_per_night")
    ),
    "get_weather": lambda i: get_weather(i["destination"], i["date"]),
    "search_knowledge_base": lambda i: search_knowledge_base(i["query"], i.get("top_k", 4)),
}


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

def run_agent_turn(client, messages):
    """Call the model, executing any tool calls, until it produces a final text reply."""
    while True:
        response = client.messages.create(
            model=MODEL,
            max_tokens=1500,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return "".join(block.text for block in response.content if block.type == "text")

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            print(f"  [tool] {block.name}({json.dumps(block.input)})")
            try:
                result = TOOL_FUNCTIONS[block.name](block.input)
            except Exception as exc:  # noqa: BLE001 — surface any tool failure back to the model
                result = {"error": str(exc)}
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(result),
            })
        messages.append({"role": "user", "content": tool_results})


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print(
            "ANTHROPIC_API_KEY is not set.\n"
            "Copy config.env.template to config.env and fill in your key, then re-run."
        )
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    messages = []

    print("Travel Agent demo — describe the trip you want to plan. Type 'exit' to quit.\n")
    while True:
        try:
            user_input = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if user_input.lower() in {"exit", "quit"}:
            break
        if not user_input:
            continue

        messages.append({"role": "user", "content": user_input})
        reply = run_agent_turn(client, messages)
        print(f"\nagent> {reply}\n")


if __name__ == "__main__":
    main()
