import { describe, expect, it } from "vitest";
import { getWeather, searchFlights, searchHotels } from "@/lib/tools";
import { stubOpenMeteo } from "../helpers/openMeteo";

describe("mock travel data", () => {
  it("is deterministic per query and labeled as mock", () => {
    const a = searchFlights("NYC", "Lisbon", "2026-11-14");
    expect(searchFlights("nyc", "LISBON", "2026-11-14")).toEqual(a); // case-insensitive seed
    expect(searchFlights("NYC", "Lisbon", "2026-11-15")).not.toEqual(a);
    expect(a.note).toMatch(/MOCK/);
    expect(searchHotels("Lisbon", "2026-11-14", "2026-11-19").note).toMatch(/MOCK/);
  });

  it("matches golden snapshots (catches accidental changes to the mock generators)", () => {
    expect(searchFlights("NYC", "Lisbon", "2026-11-14")).toMatchSnapshot();
    expect(searchHotels("Lisbon", "2026-11-14", "2026-11-19")).toMatchSnapshot();
  });

  it("returns well-formed flight results", () => {
    const { results } = searchFlights("Boston", "Rome", "2026-12-01");
    expect(results).toHaveLength(3);
    for (const f of results) {
      expect(f.flight_number).toMatch(/^(AX|BH|MR|SX|NW)\d{3}$/);
      expect(f.departs.startsWith("2026-12-01 ")).toBe(true);
      expect(f.price_usd).toBeGreaterThanOrEqual(180);
      expect(f.price_usd).toBeLessThanOrEqual(1400);
      expect([0, 1]).toContain(f.stops);
    }
  });

  it("filters hotels by budget, falling back to all results if none fit", () => {
    const all = searchHotels("Lisbon", "2026-11-14", "2026-11-19").results;
    const cheapest = Math.min(...all.map((h) => h.price_per_night_usd));
    const filtered = searchHotels("Lisbon", "2026-11-14", "2026-11-19", cheapest).results;
    expect(filtered.every((h) => h.price_per_night_usd <= cheapest)).toBe(true);
    expect(filtered.length).toBeGreaterThan(0);
    expect(searchHotels("Lisbon", "2026-11-14", "2026-11-19", 1).results).toEqual(all);
  });
});

describe("getWeather (Open-Meteo)", () => {
  it("uses the live forecast within 15 days", async () => {
    const { requests } = stubOpenMeteo({ weatherCode: 95 });
    const result = await getWeather("Lisbon", "2026-11-14");
    expect(result).toEqual({
      location: "Lisbon, Portugal",
      date: "2026-11-14",
      source: "live forecast",
      weather_code: 95,
      conditions: "Thunderstorm",
      temp_max_c: 19.2,
      temp_min_c: 15.2,
      precipitation_mm: 0.4,
    });
    const forecast = requests.find((u) => u.hostname === "api.open-meteo.com")!;
    expect(forecast.searchParams.get("daily")).toBe("weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum");
    expect(forecast.searchParams.get("start_date")).toBe("2026-11-14");
  });

  it("falls back to the same date last year beyond the forecast window, and says so", async () => {
    const { requests } = stubOpenMeteo({ weatherCode: 61 });
    const result = await getWeather("Montreal", "2027-06-10");
    expect(result).toMatchObject({ conditions: "Light rain", source: expect.stringContaining("estimate based on actual weather on 2026-06-10") });
    expect(requests.find((u) => u.hostname === "archive-api.open-meteo.com")!.searchParams.get("start_date")).toBe("2026-06-10");
  });

  it("forecast window boundary: day 15 is forecast, day 16 is an estimate", async () => {
    stubOpenMeteo();
    expect((await getWeather("Lisbon", "2026-11-25")) as { source: string }).toMatchObject({ source: "live forecast" });
    expect(((await getWeather("Lisbon", "2026-11-26")) as { source: string }).source).toMatch(/^estimate/);
  });

  it("reports errors as payloads instead of throwing", async () => {
    stubOpenMeteo();
    expect(await getWeather("Atlantis", "2026-11-14")).toEqual({ error: "Could not find location 'Atlantis'." });
    expect(await getWeather("Lisbon", "next tuesday")).toEqual({ error: "Invalid date 'next tuesday', expected YYYY-MM-DD." });
    stubOpenMeteo({ failWeather: true });
    expect(await getWeather("Lisbon", "2026-11-14")).toEqual({ error: "Weather service request failed." });
    stubOpenMeteo({ emptyDaily: true });
    expect(await getWeather("Lisbon", "2026-11-14")).toEqual({ error: "No weather data available for that date/location." });
  });

  it("maps unknown WMO codes to 'Unknown'", async () => {
    stubOpenMeteo({ weatherCode: 42 });
    expect(await getWeather("Lisbon", "2026-11-14")).toMatchObject({ weather_code: 42, conditions: "Unknown" });
  });
});
