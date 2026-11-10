import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Live regression eval (`npm run eval`) — real Claude API, real Open-Meteo. Opt-in and billed.
 * Reads ANTHROPIC_API_KEY (and optional VOYAGE_API_KEY / BLOB_READ_WRITE_TOKEN, MODEL_* overrides)
 * from .env.local or the shell. Skips itself when no API key is set.
 */
export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    env: { ...loadEnv(mode, process.cwd(), ""), LOG_LEVEL: "info" },
    testTimeout: 240_000,
    fileParallelism: false,
    maxConcurrency: 1,
  },
}));
