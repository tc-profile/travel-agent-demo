/**
 * OpenTelemetry registration — Next.js calls `register()` once per server instance, before any
 * request is handled. With this in place Next.js emits its own spans (one root span per request,
 * continuing any incoming W3C `traceparent`), `fetch` calls get child spans (Open-Meteo, Voyage,
 * Vercel Blob, the Anthropic API), and the app's custom spans in lib/agent.ts / lib/weatherMcp.ts
 * nest underneath.
 *
 * Where spans go (traceExporter "auto"):
 *   - on Vercel, to whatever observability integration the project has connected;
 *   - anywhere, to an OTLP endpoint if OTEL_EXPORTER_OTLP_ENDPOINT (+ optional
 *     OTEL_EXPORTER_OTLP_HEADERS) is set — e.g. a local Jaeger at http://localhost:4318;
 *   - set OTEL_TRACES_EXPORTER=console to print spans to the terminal while developing.
 */
import { registerOTel } from "@vercel/otel";

export async function register() {
  let traceExporter: "auto" | import("@opentelemetry/sdk-trace-base").SpanExporter = "auto";
  if (process.env.OTEL_TRACES_EXPORTER === "console" && process.env.NEXT_RUNTIME === "nodejs") {
    const { ConsoleSpanExporter } = await import("@opentelemetry/sdk-trace-base");
    traceExporter = new ConsoleSpanExporter();
  }

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME || "aviana-travel-web",
    attributes: { "deployment.environment.name": process.env.VERCEL_ENV || process.env.NODE_ENV || "development" },
    traceExporter,
  });
}
