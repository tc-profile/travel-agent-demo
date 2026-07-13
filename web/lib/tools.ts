/**
 * Agent tools: search_flights / search_hotels return deterministic MOCK data
 * (seeded by the query, no paid travel API needed for this demo). get_weather
 * calls the real, free Open-Meteo API, with a same-date-last-year fallback
 * when the trip is too far out for a forecast.
 *
 * Ported from the CLI version at agent-demo/travel_agent.py — keep both in
 * sync if the tool contracts change.
 */

const AIRLINES: Record<string, string> = {
  "Aegis Air": "AX",
  "Blue Horizon": "BH",
  Meridian: "MR",
  "Skyline Express": "SX",
  NorthWing: "NW",
};

const HOTEL_NAMES = [
  "The Wren Hotel",
  "Harborview Inn",
  "Cobalt Suites",
  "The Linden House",
  "Aster & Pine",
  "Northgate Residency",
];

/** Deterministic PRNG (mulberry32) seeded from a string, so the same query returns the same mock results. */
function seededRng(...parts: string[]) {
  let seed = 0;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) {
    seed = (Math.imul(31, seed) + str.charCodeAt(i)) | 0;
  }
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function sample<T>(rng: () => number, items: readonly T[], k: number): T[] {
  const pool = [...items];
  const result: T[] = [];
  for (let i = 0; i < k && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

function randint(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function searchFlights(origin: string, destination: string, date: string) {
  const rng = seededRng("flights", origin.toLowerCase(), destination.toLowerCase(), date);
  const airlineNames = Object.keys(AIRLINES);
  const results = Array.from({ length: 3 }, () => {
    const airline = pick(rng, airlineNames);
    const departHour = randint(rng, 5, 21);
    const departMinute = pick(rng, ["00", "15", "30", "45"]);
    return {
      airline,
      flight_number: `${AIRLINES[airline]}${randint(rng, 100, 999)}`,
      departs: `${date} ${String(departHour).padStart(2, "0")}:${departMinute}`,
      duration_hours: randint(rng, 2, 11),
      stops: pick(rng, [0, 0, 1]),
      price_usd: randint(rng, 180, 1400),
    };
  });
  return { note: "MOCK data for demo purposes — not real bookable flights.", results };
}

export function searchHotels(
  destination: string,
  checkin: string,
  checkout: string,
  maxPricePerNight?: number
) {
  const rng = seededRng("hotels", destination.toLowerCase(), checkin, checkout);
  let results = sample(rng, HOTEL_NAMES, 3).map((name) => ({
    name,
    rating: Math.round((rng() * (4.9 - 3.4) + 3.4) * 10) / 10,
    price_per_night_usd: randint(rng, 80, 450),
    area: pick(rng, ["City Center", "Old Town", "Waterfront", "Business District"]),
  }));
  if (maxPricePerNight) {
    const filtered = results.filter((h) => h.price_per_night_usd <= maxPricePerNight);
    results = filtered.length > 0 ? filtered : results;
  }
  return { note: "MOCK data for demo purposes — not real bookable hotels.", results };
}

async function geocode(place: string) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", place);
  url.searchParams.set("count", "1");
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const data = await res.json();
  const result = data.results?.[0];
  if (!result) return null;
  return {
    lat: result.latitude as number,
    lon: result.longitude as number,
    name: (result.name as string) ?? place,
    country: (result.country as string) ?? "",
  };
}

export async function getWeather(destination: string, dateStr: string) {
  const geo = await geocode(destination);
  if (!geo) return { error: `Could not find location '${destination}'.` };

  const target = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) {
    return { error: `Invalid date '${dateStr}', expected YYYY-MM-DD.` };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysOut = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  let url: URL;
  let source: string;
  if (daysOut >= 0 && daysOut <= 15) {
    url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("start_date", dateStr);
    url.searchParams.set("end_date", dateStr);
    source = "live forecast";
  } else {
    const estimate = new Date(target);
    estimate.setUTCFullYear(estimate.getUTCFullYear() - 1);
    const estimateStr = estimate.toISOString().slice(0, 10);
    url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("start_date", estimateStr);
    url.searchParams.set("end_date", estimateStr);
    source = `estimate based on actual weather on ${estimateStr} (forecast unavailable this far out)`;
  }
  url.searchParams.set("latitude", String(geo.lat));
  url.searchParams.set("longitude", String(geo.lon));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum");
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { error: "Weather service request failed." };
  const data = await res.json();
  const daily = data.daily;
  if (!daily?.time?.length) return { error: "No weather data available for that date/location." };

  return {
    location: `${geo.name}, ${geo.country}`,
    date: dateStr,
    source,
    temp_max_c: daily.temperature_2m_max[0],
    temp_min_c: daily.temperature_2m_min[0],
    precipitation_mm: daily.precipitation_sum[0],
  };
}
