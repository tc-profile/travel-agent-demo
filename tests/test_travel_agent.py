"""Regression tests for the CLI agent (travel_agent.py). Run: pytest"""
import json
from datetime import date
from types import SimpleNamespace

import pytest

import travel_agent as ta


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

def test_tools_and_dispatch_table_stay_in_sync():
    assert sorted(t["name"] for t in ta.TOOLS) == sorted(ta.TOOL_FUNCTIONS)


def test_every_tool_schema_is_well_formed():
    for tool in ta.TOOLS:
        schema = tool["input_schema"]
        assert schema["type"] == "object"
        assert set(schema["required"]) <= set(schema["properties"]), tool["name"]
        assert tool["description"]


def test_mock_tools_say_they_are_mock():
    for name in ("search_flights", "search_hotels"):
        desc = next(t["description"] for t in ta.TOOLS if t["name"] == name)
        assert "MOCK" in desc


# ---------------------------------------------------------------------------
# Mock data
# ---------------------------------------------------------------------------

def test_flights_are_deterministic_and_labeled():
    a = ta.search_flights("NYC", "Lisbon", "2026-11-14")
    assert ta.search_flights("nyc", "LISBON", "2026-11-14") == a
    assert ta.search_flights("NYC", "Lisbon", "2026-11-15") != a
    assert "MOCK" in a["note"]
    assert len(a["results"]) == 3
    for f in a["results"]:
        assert f["departs"].startswith("2026-11-14 ")
        assert 180 <= f["price_usd"] <= 1400
        assert f["flight_number"][:2] in ta._AIRLINES.values()


def test_hotels_budget_filter_falls_back_to_all_when_nothing_fits():
    all_hotels = ta.search_hotels("Lisbon", "2026-11-14", "2026-11-19")["results"]
    cheapest = min(h["price_per_night_usd"] for h in all_hotels)
    filtered = ta.search_hotels("Lisbon", "2026-11-14", "2026-11-19", cheapest)["results"]
    assert filtered and all(h["price_per_night_usd"] <= cheapest for h in filtered)
    assert ta.search_hotels("Lisbon", "2026-11-14", "2026-11-19", 1)["results"] == all_hotels


# ---------------------------------------------------------------------------
# Weather (Open-Meteo, faked)
# ---------------------------------------------------------------------------

class FixedDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 11, 10)


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


@pytest.fixture
def open_meteo(monkeypatch):
    """Fake requests.get for Open-Meteo; records calls. Configure via the returned dict."""
    state = {"code": 2, "calls": [], "cities": {"Lisbon": (38.72, -9.14, "Lisbon", "Portugal")}}

    def fake_get(url, params=None, timeout=None):
        state["calls"].append((url, params))
        if "geocoding" in url:
            city = state["cities"].get(params["name"])
            if not city:
                return FakeResponse({})
            lat, lon, name, country = city
            return FakeResponse({"results": [{"latitude": lat, "longitude": lon, "name": name, "country": country}]})
        return FakeResponse({
            "daily": {
                "time": [params["start_date"]],
                "weather_code": [state["code"]],
                "temperature_2m_max": [19.2],
                "temperature_2m_min": [15.2],
                "precipitation_sum": [0.4],
            }
        })

    monkeypatch.setattr(ta.requests, "get", fake_get)
    monkeypatch.setattr(ta, "date", FixedDate)
    return state


def test_weather_uses_live_forecast_within_window(open_meteo):
    open_meteo["code"] = 95
    result = ta.get_weather("Lisbon", "2026-11-14")
    assert result == {
        "location": "Lisbon, Portugal",
        "date": "2026-11-14",
        "source": "live forecast",
        "weather_code": 95,
        "conditions": "Thunderstorm",
        "temp_max_c": 19.2,
        "temp_min_c": 15.2,
        "precipitation_mm": 0.4,
    }
    url, params = open_meteo["calls"][-1]
    assert "api.open-meteo.com/v1/forecast" in url
    assert params["daily"] == "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"


def test_weather_falls_back_to_last_year_estimate(open_meteo):
    result = ta.get_weather("Lisbon", "2027-06-10")
    assert result["source"].startswith("estimate based on actual weather on 2026-06-10")
    url, params = open_meteo["calls"][-1]
    assert "archive-api" in url and params["start_date"] == "2026-06-10"


def test_weather_forecast_window_boundary(open_meteo):
    assert ta.get_weather("Lisbon", "2026-11-25")["source"] == "live forecast"  # day 15
    assert ta.get_weather("Lisbon", "2026-11-26")["source"].startswith("estimate")  # day 16


def test_weather_errors_are_payloads(open_meteo):
    assert ta.get_weather("Atlantis", "2026-11-14") == {"error": "Could not find location 'Atlantis'."}
    assert ta.get_weather("Lisbon", "next tuesday") == {"error": "Invalid date 'next tuesday', expected YYYY-MM-DD."}


@pytest.mark.parametrize("code,label", [(0, "Clear sky"), (3, "Overcast"), (61, "Light rain"), (42, "Unknown")])
def test_weather_condition_labels(open_meteo, code, label):
    open_meteo["code"] = code
    assert ta.get_weather("Lisbon", "2026-11-14")["conditions"] == label


# ---------------------------------------------------------------------------
# Knowledge base degrades gracefully
# ---------------------------------------------------------------------------

def test_knowledge_base_reports_unavailable_without_key(monkeypatch):
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    assert "VOYAGE_API_KEY" in ta.search_knowledge_base("baggage")["error"]


def test_knowledge_base_reports_missing_ingest(monkeypatch):
    monkeypatch.setenv("VOYAGE_API_KEY", "test")
    monkeypatch.setattr(ta, "_kb_collection", False)  # already checked: collection absent
    assert "ingest.py" in ta.search_knowledge_base("baggage")["error"]


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

def _block(**kw):
    return SimpleNamespace(**kw)


class FakeClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        return self._responses.pop(0)


def test_agent_loop_runs_tools_and_returns_final_text(capsys):
    client = FakeClient([
        SimpleNamespace(stop_reason="tool_use", content=[
            _block(type="tool_use", id="t1", name="search_flights", input={"origin": "NYC", "destination": "Lisbon", "date": "2026-11-14"}),
            _block(type="tool_use", id="t2", name="no_such_tool", input={}),
        ]),
        SimpleNamespace(stop_reason="end_turn", content=[_block(type="text", text="Here is "), _block(type="text", text="your plan.")]),
    ])
    messages = [{"role": "user", "content": "Plan Lisbon"}]
    assert ta.run_agent_turn(client, messages) == "Here is your plan."

    first = client.requests[0]
    assert first["system"] == ta.SYSTEM_PROMPT and first["tools"] == ta.TOOLS and first["model"] == ta.MODEL

    tool_turn = messages[2]
    assert tool_turn["role"] == "user"
    results = {r["tool_use_id"]: json.loads(r["content"]) for r in tool_turn["content"]}
    assert "MOCK" in results["t1"]["note"]
    assert "error" in results["t2"]  # unknown tool surfaces as an error result, not a crash
    assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]
    assert "[tool] search_flights" in capsys.readouterr().out


def test_main_exits_with_setup_help_without_api_key(monkeypatch, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(SystemExit) as exc:
        ta.main()
    assert exc.value.code == 1
    assert "config.env" in capsys.readouterr().out
