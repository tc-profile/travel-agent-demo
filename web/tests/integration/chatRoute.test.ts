/**
 * HTTP-level contract of POST /api/chat. The Anthropic SDK module is mocked so `new Anthropic()`
 * inside the route returns the scripted fake client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentOf, grade, reply, route, type Handler, type Params } from "../helpers/fakeClaude";
import { logs } from "../helpers/logs";

const fake = vi.hoisted(() => ({
  handlers: {} as Record<string, (p: unknown, ctx: { call: number }) => unknown>,
  apiKeys: [] as string[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    beta: unknown;
    constructor(opts: { apiKey: string }) {
      fake.apiKeys.push(opts.apiKey);
      const counts = new Map<string, number>();
      this.beta = {
        messages: {
          create: async (p: Params) => {
            const agent = agentOf(p);
            const n = (counts.get(agent) ?? 0) + 1;
            counts.set(agent, n);
            const h = fake.handlers[agent];
            if (!h) throw new Error(`unexpected agent ${agent}`);
            return h(p, { call: n });
          },
        },
      };
    }
  },
}));

const { POST } = await import("@/app/api/chat/route");

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function script(handlers: Partial<Record<string, Handler>>) {
  fake.handlers = handlers as typeof fake.handlers;
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");
  fake.apiKeys.length = 0;
  script({
    router: route({ tasks: [{ agent: "trip_planner", brief: "x" }] }),
    trip_planner: reply("Where from, and when?"),
    evaluator: grade("pass"),
  });
});

describe("POST /api/chat", () => {
  it("returns the reply, text-only history, weather, and agent meta", async () => {
    const res = await post({ messages: [], message: "Tokyo trip" }, { "x-conversation-id": "3f2c9a1e-0000-4000-8000-000000000001" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      messages: [
        { role: "user", content: "Tokyo trip" },
        { role: "assistant", content: [{ type: "text", text: "Where from, and when?" }] },
      ],
      reply: "Where from, and when?",
      weather: [],
      compacted: false,
      meta: { agents: [{ name: "Trip Planner", model: "Sonnet 5.5" }], review: "passed", escalated: false },
    });
    expect(fake.apiKeys).toEqual(["sk-test-key"]);
    expect(logs("chat.request.completed")[0]).toMatchObject({
      outcome: "clarifying_question",
      status: 200,
      conversation_id: "3f2c9a1e-0000-4000-8000-000000000001",
    });
  });

  it("round-trips its own history on the next turn", async () => {
    const first = await (await post({ messages: [], message: "Tokyo trip" })).json();
    script({
      router: route({ tasks: [{ agent: "trip_planner", brief: "x" }] }),
      trip_planner: (p) => {
        expect(p.messages.slice(0, 2)).toEqual(first.messages);
        return reply("From NYC on Dec 1 — got it.")(p, { call: 1 });
      },
      evaluator: grade("pass"),
    });
    const second = await (await post({ messages: first.messages, message: "From NYC, Dec 1" })).json();
    expect(second.messages).toHaveLength(4);
  });

  it("ignores malformed conversation ids", async () => {
    await post({ messages: [], message: "hi" }, { "x-conversation-id": "<script>" });
    expect(logs("chat.request.received")[0]).not.toHaveProperty("conversation_id");
  });

  it.each([
    [{ messages: [], message: "   " }, 400, "empty_message", /Message is required/],
    [{ messages: [] }, 400, "empty_message", /Message is required/],
    ["{not json", 400, "empty_message", /Message is required/],
    [{ messages: Array.from({ length: 401 }, () => ({ role: "user", content: "x" })), message: "hi" }, 400, "history_too_long", /too long/],
    [{ messages: [{ role: "user", content: "x".repeat(1_600_000) }], message: "hi" }, 413, "request_too_large", /too large/],
  ])("rejects bad requests (%#)", async (body, status, reason, error) => {
    const res = await post(body);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toMatch(error);
    expect(logs("chat.request.rejected")[0]).toMatchObject({ outcome: "rejected", reason, status });
  });

  it("500s with a generic error (no internals) when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const res = await post({ messages: [], message: "hi" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Server is missing ANTHROPIC_API_KEY." });
  });

  it("500s with a generic error when the agent fails, and logs the cause", async () => {
    script({
      router: route({ tasks: [{ agent: "trip_planner", brief: "x" }] }),
      trip_planner: () => {
        throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
      },
    });
    const res = await post({ messages: [], message: "hi" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Something went wrong talking to the agent." });
    expect(JSON.stringify(body)).not.toContain("x-api-key");
    expect(logs("chat.request.failed")[0]).toMatchObject({ outcome: "error", error: { message: "invalid x-api-key", status: 401 } });
  });
});
