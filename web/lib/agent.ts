import Anthropic from "@anthropic-ai/sdk";
import { searchKnowledgeBase } from "./knowledge";
import { searchFlights, searchHotels } from "./tools";
import { connectWeatherMcp, type WeatherMcpSession, type WeatherReport } from "./weatherMcp";

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
estimate based on the same date last year — say so when you use it). Each
get_weather result is also shown to the customer as a weather card next to
your reply, so summarize it briefly rather than repeating every number.

You also have access to search_knowledge_base, which searches Aviana's own
reference documents (booking/cancellation policy, loyalty program, baggage
rules, entry-document guidance, group bookings). Call it when a question
might be answered by that material — policy, fees, loyalty program, baggage,
documents — rather than guessing. If it returns no useful match, fall back
to your general knowledge and say the answer isn't from Aviana's documents.

Keep responses concise and skimmable: short paragraphs, bullet points for
options and itinerary days. Format with markdown.`;

/** Locally-implemented tools. get_weather is NOT here — it's discovered from the weather MCP server (lib/weatherMcp.ts). */
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
  search_knowledge_base: (i) => searchKnowledgeBase(i.query as string, (i.top_k as number) ?? 4),
};

/** Opens the weather MCP session; if it can't connect, the agent still runs, just without weather. */
async function openWeatherMcp(): Promise<WeatherMcpSession | null> {
  try {
    return await connectWeatherMcp();
  } catch (err) {
    console.warn("weather MCP server unavailable — continuing without get_weather", err);
    return null;
  }
}

export async function runAgentTurn(client: Anthropic, messages: Anthropic.MessageParam[]) {
  const mcp = await openWeatherMcp();
  const tools = [...TOOLS, ...(mcp?.tools ?? [])];
  // Weather reports from MCP tool calls this turn, returned alongside the reply for the UI to render.
  const weather: WeatherReport[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const reply = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        return { messages, reply, weather };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input as ToolInput;
        try {
          if (mcp?.has(block.name)) {
            const outcome = await mcp.call(block.name, input);
            if (outcome.weather) weather.push(outcome.weather);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: outcome.text,
              is_error: outcome.isError || undefined,
            });
            continue;
          }
          const fn = TOOL_FUNCTIONS[block.name];
          if (!fn) throw new Error(`Unknown tool '${block.name}'.`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(await fn(input)) });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return {
      messages,
      reply: "I wasn't able to finish planning this within the demo's tool-call limit — try narrowing your request.",
      weather,
    };
  } finally {
    await mcp?.close().catch(() => {});
  }
}
