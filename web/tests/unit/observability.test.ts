import { describe, expect, it, vi } from "vitest";
import { currentTraceId, logger, serializeError, toAttributes, userText, withSpan } from "@/lib/observability";
import { logs, rawLines } from "../helpers/logs";

describe("structured JSON logging", () => {
  it("writes one JSON object per line with the standard envelope", () => {
    logger.info("test.event.happened", { intent: { tool: "x" }, outcome: "ok", n: 1 });
    const [line] = rawLines();
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      ts: "2026-11-10T12:00:00.000Z",
      level: "info",
      event: "test.event.happened",
      service: "aviana-travel-web",
      env: "test",
      intent: { tool: "x" },
      outcome: "ok",
      n: 1,
    });
  });

  it("omits trace ids when no tracer provider is registered", () => {
    logger.info("x");
    expect(logs("x")[0]).not.toHaveProperty("trace_id");
    expect(currentTraceId()).toBeUndefined();
  });

  it("routes levels to the right console method", () => {
    logger.warn("w");
    logger.error("e");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("serializes errors (class name, message, HTTP status) inside fields", () => {
    class AuthenticationError extends Error {
      status = 401;
    }
    logger.error("boom", { error: new AuthenticationError("invalid x-api-key") });
    expect(logs("boom")[0].error).toEqual({ type: "AuthenticationError", message: "invalid x-api-key", status: 401 });
    expect(serializeError("plain")).toEqual({ type: "UnknownError", message: "plain" });
  });

  it("honors LOG_LEVEL", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.resetModules();
    const mod = await import("@/lib/observability");
    mod.logger.info("hidden");
    mod.logger.warn("shown");
    expect(logs("hidden")).toHaveLength(0);
    expect(logs("shown")).toHaveLength(1);
  });
});

describe("customer content policy (LOG_USER_CONTENT)", () => {
  it("preview (default) truncates long text and always reports length", () => {
    expect(userText("short")).toEqual({ chars: 5, text: "short" });
    const long = userText("a".repeat(200));
    expect(long).toEqual({ chars: 200, text: `${"a".repeat(160)}…`, truncated: true });
  });

  it.each([
    ["none", { chars: 200 }],
    ["full", { chars: 200, text: "a".repeat(200) }],
  ])("%s mode", async (mode, expected) => {
    vi.stubEnv("LOG_USER_CONTENT", mode);
    vi.resetModules();
    const mod = await import("@/lib/observability");
    expect(mod.userText("a".repeat(200))).toEqual(expected);
  });
});

describe("tracing helpers", () => {
  it("toAttributes flattens fields into OTel-safe primitives", () => {
    expect(toAttributes({ a: 1, b: "x", c: true, d: ["p", "q"], e: { nested: 1 }, f: null, g: undefined, h: [1, 2] })).toEqual({
      a: 1,
      b: "x",
      c: true,
      d: ["p", "q"],
      e: '{"nested":1}',
      h: [1, 2],
    });
  });

  it("withSpan returns the value, and re-throws errors", async () => {
    await expect(withSpan("ok", {}, async () => 42)).resolves.toBe(42);
    await expect(
      withSpan("fail", {}, async () => {
        throw new Error("nope");
      })
    ).rejects.toThrow("nope");
  });
});
