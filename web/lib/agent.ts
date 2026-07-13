import Anthropic from "@anthropic-ai/sdk";
import { searchKnowledgeBase } from "./knowledge";
import { getWeather, searchFlights, searchHotels } from "./tools";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

/** Hard cap on tool-call rounds within a single turn, so a pathological loop can't run away on cost. */
const MAX_TOOL_ROUNDS = 6;

export const SYSTEM_PROMPT = `You are a travel planning assistant demo.

Goal: help the user plan a trip. Before calling any tools, make sure you
know the origin, destination, travel dates, and (if relevant) budget or
preferences — ask concise follow-up questions for anything missing.

Once you have enough information, call the available tools to gather
flight options, hotel options, and weather, then propose a clear
day-by-day itinerary with your top flight and hotel picks and a packing
note based on the weather.

Flight and hotel data are clearly-labeled MOCK data for this demo — say so
plainly if the user asks whether they can book through you (they can't).
Weather data is real (or, when the date is too far out for a forecast, an
estimate based on the same date last year — say so when you use it).

You also have access to search_knowledge_base, which searches Aviana's own
reference documents (booking/cancellation policy, loyalty program, baggage
rules, entry-document guidance, group bookings). Call it when a question
might be answered by that material — policy, fees, loyalty program, baggage,
documents — rather than guessing. If it returns no useful match, fall back
to your general knowledge and say the answer isn't from Aviana's documents.

Keep responses concise and skimmable: short paragraphs, bullet points for
options and itinerary days. Format with markdown.`;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_flights",
    description:
      "Search for flights between two cities on a given date. Returns MOCK data for demo purposes, not real bookable flights.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin city or airport" },
        destination: { type: "string", description: "Destination city or airport" },
        date: { type: "string", description: "Departure date, YYYY-MM-DD" },
      },
      required: ["origin", "destination", "date"],
    },
  },
  {
    name: "search_hotels",
    description:
      "Search for hotels in a destination city for a date range. Returns MOCK data for demo purposes, not real bookable hotels.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Destination city" },
        checkin: { type: "string", description: "Check-in date, YYYY-MM-DD" },
        checkout: { type: "string", description: "Check-out date, YYYY-MM-DD" },
        max_price_per_night: { type: "number", description: "Optional budget ceiling per night, in USD" },
      },
      required: ["destination", "checkin", "checkout"],
    },
  },
  {
    name: "get_weather",
    description:
      "Get real weather for a destination on a given date, via Open-Meteo. Uses a live forecast if the date is within ~16 days; otherwise falls back to actual weather from the same date last year as an estimate.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Destination city" },
        date: { type: "string", description: "Date, YYYY-MM-DD" },
      },
      required: ["destination", "date"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Search Aviana's own reference documents — booking/cancellation policy, loyalty program, baggage rules, entry-document guidance, group bookings, customer support — for a relevant passage. Use for policy/fee/program questions instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        top_k: { type: "integer", description: "Number of matching passages to return (default 4)" },
      },
      required: ["query"],
    },
  },
];

type ToolInput = Record<string, unknown>;

const TOOL_FUNCTIONS: Record<string, (input: ToolInput) => unknown | Promise<unknown>> = {
  search_flights: (i) => searchFlights(i.origin as string, i.destination as string, i.date as string),
  search_hotels: (i) =>
    searchHotels(
      i.destination as string,
      i.checkin as string,
      i.checkout as string,
      i.max_price_per_night as number | undefined
    ),
  get_weather: (i) => getWeather(i.destination as string, i.date as string),
  search_knowledge_base: (i) => searchKnowledgeBase(i.query as string, (i.top_k as number) ?? 4),
};

export async function runAgentTurn(client: Anthropic, messages: Anthropic.MessageParam[]) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const reply = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { messages, reply };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      let result: unknown;
      try {
        result = await TOOL_FUNCTIONS[block.name](block.input as ToolInput);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    messages,
    reply: "I wasn't able to finish planning this within the demo's tool-call limit — try narrowing your request.",
  };
}
