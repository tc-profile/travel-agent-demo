import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Offline regression suite (`npm test`): no network, no API keys, fixed clock.
 * Claude is replaced by a scripted fake client (tests/helpers/fakeClaude.ts) and Open-Meteo by a
 * fetch stub (tests/helpers/openMeteo.ts). The live, opt-in eval has its own config
 * (vitest.eval.config.mts).
 */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // Pin every env var the app reads at import time, so a developer's shell can't change results.
    env: {
      LOG_LEVEL: "debug",
      LOG_USER_CONTENT: "preview",
      EVAL_MODE: "auto",
      EVAL_MAX_REVISIONS: "1",
      REFUSAL_FALLBACKS: "on",
      REFUSAL_FALLBACK_MODEL: "",
      MODEL_FAST: "",
      MODEL_BALANCED: "",
      MODEL_DEEP: "",
      WEATHER_MCP_URL: "",
      COMPACTION_TRIGGER_TOKENS: "",
      OTEL_SERVICE_NAME: "",
      VERCEL_ENV: "",
      VOYAGE_API_KEY: "",
      BLOB_READ_WRITE_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    },
  },
});
