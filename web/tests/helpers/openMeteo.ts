import { vi } from "vitest";

/**
 * Fake Open-Meteo (geocoding, forecast, archive) installed as global `fetch`. Any other URL fails
 * the test loudly, so the offline suite can never make a real network call.
 */
export const CITIES: Record<string, { latitude: number; longitude: number; name: string; country: string }> = {
  lisbon: { latitude: 38.72509, longitude: -9.1498, name: "Lisbon", country: "Portugal" },
  porto: { latitude: 41.14961, longitude: -8.61099, name: "Porto", country: "Portugal" },
  montreal: { latitude: 45.50884, longitude: -73.58781, name: "Montreal", country: "Canada" },
  tokyo: { latitude: 35.6895, longitude: 139.69171, name: "Tokyo", country: "Japan" },
};

export type OpenMeteoOptions = {
  weatherCode?: number;
  tempMax?: number;
  tempMin?: number;
  precipitation?: number;
  /** Make the forecast/archive endpoint return HTTP 500. */
  failWeather?: boolean;
  /** Return no daily data. */
  emptyDaily?: boolean;
};

export function stubOpenMeteo(opts: OpenMeteoOptions = {}) {
  const requests: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);

    if (url.hostname === "geocoding-api.open-meteo.com") {
      const city = CITIES[(url.searchParams.get("name") ?? "").toLowerCase()];
      return Response.json(city ? { results: [city] } : {});
    }
    if (url.hostname === "api.open-meteo.com" || url.hostname === "archive-api.open-meteo.com") {
      if (opts.failWeather) return new Response("upstream error", { status: 500 });
      const day = url.searchParams.get("start_date");
      return Response.json({
        daily: opts.emptyDaily
          ? { time: [] }
          : {
              time: [day],
              weather_code: [opts.weatherCode ?? 2],
              temperature_2m_max: [opts.tempMax ?? 19.2],
              temperature_2m_min: [opts.tempMin ?? 15.2],
              precipitation_sum: [opts.precipitation ?? 0.4],
            },
      });
    }
    throw new Error(`Unexpected network call in offline test: ${url.href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}
