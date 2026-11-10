import { vi } from "vitest";

/**
 * Captures the app's structured JSON logs (one JSON object per console line) so tests can assert on
 * the observability contract — event names and their intent/outcome fields — and keep test output
 * quiet. Started for every test by tests/setup.ts.
 */
export type LogRecord = { event: string; level: string; [key: string]: unknown };

const captured: LogRecord[] = [];
const raw: string[] = [];

export function startLogCapture() {
  captured.length = 0;
  raw.length = 0;
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line?: unknown) => {
      const text = String(line);
      raw.push(text);
      try {
        captured.push(JSON.parse(text));
      } catch {
        /* not a structured log line */
      }
    });
  }
}

export function logs(event?: string): LogRecord[] {
  return event ? captured.filter((l) => l.event === event) : [...captured];
}

export function rawLines() {
  return [...raw];
}
