import type { WeatherReport } from "@/lib/weatherMcp";

function icon(code: number | null) {
  if (code === null) return "🌡️";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 67 || (code >= 80 && code <= 82)) return "🌧️";
  if (code <= 77 || code === 85 || code === 86) return "❄️";
  return "⛈️";
}

function temp(c: number | null) {
  if (c === null) return "—";
  return `${Math.round(c)}°C / ${Math.round((c * 9) / 5 + 32)}°F`;
}

function formatDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Renders one `get_weather` result returned by the weather MCP server. */
export default function WeatherCard({ report }: { report: WeatherReport }) {
  const isForecast = report.source === "live forecast";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-foreground">
      <span className="text-2xl leading-none" aria-hidden>
        {icon(report.weather_code)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold">{report.location}</p>
          <p className="shrink-0 text-xs text-muted">{formatDate(report.date)}</p>
        </div>
        <p className="text-xs text-foreground/80">
          {report.conditions} · High {temp(report.temp_max_c)} · Low {temp(report.temp_min_c)}
          {report.precipitation_mm !== null && ` · ${report.precipitation_mm} mm rain`}
        </p>
        <p
          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
            isForecast ? "bg-primary/10 text-primary" : "bg-background text-muted"
          }`}
          title={report.source}
        >
          {isForecast ? "Live forecast" : "Estimate · same date last year"}
        </p>
      </div>
    </div>
  );
}
