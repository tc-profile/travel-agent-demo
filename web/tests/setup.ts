import { afterEach, beforeEach, vi } from "vitest";
import { startLogCapture } from "./helpers/logs";

/** Fixed "today" for every test: date guardrails and forecast-vs-estimate logic depend on it. */
export const TODAY = "2026-11-10";

beforeEach(() => {
  // Fake only Date — real timers keep async code (MCP transports, promises) running normally.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  startLogCapture();
});

afterEach(() => {
  vi.useRealTimers();
});
