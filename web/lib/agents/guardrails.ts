/**
 * Agentic guardrails, in three layers. All deterministic (no model calls), so they are fast, free,
 * and can't be talked out of their decisions. Model-based judgment (topic/safety triage, quality
 * review) lives in the router and the evaluator; these checks feed both.
 *
 *   input  — runs before any model sees the message: size cap, payment-card redaction,
 *            prompt-injection heuristics (flagged for the router, which makes the call).
 *   tool   — runs before every tool executes: per-agent tool allowlist + argument validation.
 *            A blocked call returns an error tool_result, so the agent can correct itself.
 *   output — runs on every draft reply: booking-confirmation claims, flight numbers / hotels that
 *            no tool returned, missing mock-data disclosure on booking requests, card-number echo.
 */
import { logger, userText } from "../observability";
import type { AgentName } from "./models";

export const MAX_USER_MESSAGE_CHARS = 4000;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhnValid(digits: string) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replaces Luhn-valid 13–19 digit sequences (payment cards) with a placeholder. */
export function redactCards(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const out = text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    redacted++;
    return "[REDACTED_CARD]";
  });
  return { text: out, redacted };
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["ignore_instructions", /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|your)\b.{0,20}\b(instructions?|rules|prompt)/i],
  ["reveal_prompt", /\b(show|reveal|print|repeat|output)\b.{0,30}\b(system prompt|instructions|hidden prompt)/i],
  ["role_override", /\byou are (now|no longer)\b|\bact as (an? )?(unrestricted|jailbroken|dan)\b|\bdeveloper mode\b/i],
  ["fake_system_tag", /<\/?(system|assistant|routing_brief|evaluator_feedback)>|\[\s*system\s*\]/i],
];

export type InputCheck = {
  /** The message the agents will see (cards redacted). */
  message: string;
  blocked: false | { reason: "too_long"; reply: string };
  cardsRedacted: number;
  injectionSignals: string[];
};

export function checkInput(raw: string): InputCheck {
  if (raw.length > MAX_USER_MESSAGE_CHARS) {
    logger.warn("guardrail.input.blocked", { outcome: "blocked", reason: "too_long", chars: raw.length });
    return {
      message: raw,
      blocked: {
        reason: "too_long",
        reply: `That message is a bit long for me (over ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters). Could you shorten it or split it into a couple of messages?`,
      },
      cardsRedacted: 0,
      injectionSignals: [],
    };
  }
  const { text, redacted } = redactCards(raw);
  const injectionSignals = INJECTION_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (redacted || injectionSignals.length) {
    logger.warn("guardrail.input.flagged", {
      outcome: "flagged",
      cards_redacted: redacted,
      injection_signals: injectionSignals,
      user_message: userText(text),
    });
  }
  return { message: text, blocked: false, cardsRedacted: redacted, injectionSignals };
}

export const CARD_NOTICE =
  "_For your security I removed what looked like a payment card number from your message — please don't share card details in chat. This demo can't take payments or make bookings._";

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const TOOL_ALLOWLIST: Record<AgentName, readonly string[]> = {
  trip_planner: ["search_flights", "search_hotels", "get_weather"],
  weather_specialist: ["get_weather"],
  policy_expert: ["search_knowledge_base"],
  concierge: [],
};

const DAY_MS = 86_400_000;

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function todayUtc() {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

function shortString(value: unknown, field: string, max = 100): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} is required`;
  if (value.length > max) return `${field} must be at most ${max} characters`;
  return null;
}

/** Returns a violation message, or null if the call may run. */
export function checkToolCall(agent: AgentName, tool: string, input: Record<string, unknown>): string | null {
  if (!TOOL_ALLOWLIST[agent].includes(tool)) {
    return `Tool '${tool}' is not available to the ${agent} agent.`;
  }
  const today = todayUtc();
  const check = (...errors: (string | null)[]) => errors.find(Boolean) ?? null;

  switch (tool) {
    case "search_flights": {
      const date = parseIsoDate(input.date);
      return check(
        shortString(input.origin, "origin"),
        shortString(input.destination, "destination"),
        !date ? "date must be a real calendar date in YYYY-MM-DD format" : null,
        date && date < today ? "date is in the past — flights can only be searched for today or later" : null,
        date && date.getTime() - today.getTime() > 730 * DAY_MS ? "date is more than 2 years out" : null
      );
    }
    case "search_hotels": {
      const checkin = parseIsoDate(input.checkin);
      const checkout = parseIsoDate(input.checkout);
      const nights = checkin && checkout ? (checkout.getTime() - checkin.getTime()) / DAY_MS : 0;
      const price = input.max_price_per_night;
      return check(
        shortString(input.destination, "destination"),
        !checkin || !checkout ? "checkin and checkout must be real dates in YYYY-MM-DD format" : null,
        checkin && checkin < today ? "checkin is in the past" : null,
        checkin && checkout && nights < 1 ? "checkout must be after checkin" : null,
        nights > 30 ? "stays longer than 30 nights aren't supported — split the search" : null,
        price !== undefined && !(typeof price === "number" && price > 0 && price < 100_000)
          ? "max_price_per_night must be a positive number"
          : null
      );
    }
    case "get_weather": {
      const date = parseIsoDate(input.date);
      return check(
        shortString(input.destination, "destination"),
        !date ? "date must be a real calendar date in YYYY-MM-DD format" : null,
        date && Math.abs(date.getTime() - today.getTime()) > 730 * DAY_MS ? "date must be within 2 years of today" : null
      );
    }
    case "search_knowledge_base": {
      const topK = input.top_k;
      return check(
        shortString(input.query, "query", 500),
        topK !== undefined && !(Number.isInteger(topK) && (topK as number) >= 1 && (topK as number) <= 8)
          ? "top_k must be an integer from 1 to 8"
          : null
      );
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type OutputFinding = {
  rule: "claims_booking" | "ungrounded_flight" | "ungrounded_hotel" | "missing_mock_disclosure" | "card_echo";
  severity: "block" | "revise";
  detail: string;
};

const BOOKING_CLAIM =
  /\b(i(?:'ve| have)|we(?:'ve| have)|i just|successfully)\s+(booked|reserved|purchased|confirmed your (booking|reservation))|\b(booking|confirmation|reservation)\s+(number|code|reference|id)\s*(is|:)/i;
const FLIGHT_NUMBER = /\b(AX|BH|MR|SX|NW)\s?(\d{3})\b/g;
const HOTEL_NAMES = ["The Wren Hotel", "Harborview Inn", "Cobalt Suites", "The Linden House", "Aster & Pine", "Northgate Residency"];
const BOOKING_ASK = /\b(book|reserve|purchase|buy|pay|checkout)\b/i;
const MOCK_DISCLOSURE = /\b(mock|demo|sample|not real|can(?:'|no)t (actually )?book|unable to book)\b/i;

/**
 * Deterministic checks on a draft reply. `evidence` is everything the reply may legitimately cite:
 * this turn's tool results plus the conversation so far.
 */
export function checkOutput(reply: string, ctx: { userMessage: string; evidence: string }): OutputFinding[] {
  const findings: OutputFinding[] = [];
  const evidence = ctx.evidence.replace(/\s/g, "").toUpperCase();

  if (BOOKING_CLAIM.test(reply)) {
    findings.push({ rule: "claims_booking", severity: "block", detail: "Reply claims a booking/confirmation; this demo cannot book." });
  }
  const flights = new Set([...reply.matchAll(FLIGHT_NUMBER)].map((m) => `${m[1]}${m[2]}`));
  const ungroundedFlights = [...flights].filter((f) => !evidence.includes(f));
  if (ungroundedFlights.length) {
    findings.push({
      rule: "ungrounded_flight",
      severity: "revise",
      detail: `Flight numbers not returned by any tool: ${ungroundedFlights.join(", ")}.`,
    });
  }
  const evidenceText = ctx.evidence.toLowerCase();
  const ungroundedHotels = HOTEL_NAMES.filter((h) => reply.includes(h) && !evidenceText.includes(h.toLowerCase()));
  if (ungroundedHotels.length) {
    findings.push({
      rule: "ungrounded_hotel",
      severity: "revise",
      detail: `Hotels not returned by any tool: ${ungroundedHotels.join(", ")}.`,
    });
  }
  if (BOOKING_ASK.test(ctx.userMessage) && !MOCK_DISCLOSURE.test(reply)) {
    findings.push({
      rule: "missing_mock_disclosure",
      severity: "revise",
      detail: "Customer asked to book/pay; reply must say results are mock demo data and nothing can be booked here.",
    });
  }
  if (redactCards(reply).redacted > 0) {
    findings.push({ rule: "card_echo", severity: "block", detail: "Reply contains a payment card number." });
  }
  return findings;
}

/** Last-resort reply when a blocking finding survives revision. */
export const SAFE_FALLBACK_REPLY =
  "I want to make sure I give you accurate information, and I couldn't verify my last answer. Just to be clear: this is a demo — flight and hotel results are sample data and I can't make bookings or take payments. Could you tell me a bit more about what you'd like, and I'll try again?";
