import Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/agent";

const MAX_HISTORY_MESSAGES = 60;

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Server is missing ANTHROPIC_API_KEY." }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const priorMessages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessage = typeof body?.message === "string" ? body.message.trim() : "";

  if (!userMessage) {
    return Response.json({ error: "Message is required." }, { status: 400 });
  }
  if (priorMessages.length > MAX_HISTORY_MESSAGES) {
    return Response.json(
      { error: "This demo conversation has gotten long — please refresh to start a new one." },
      { status: 400 }
    );
  }

  const messages: Anthropic.MessageParam[] = [...priorMessages, { role: "user", content: userMessage }];

  const client = new Anthropic({ apiKey });
  try {
    const { messages: updated, reply } = await runAgentTurn(client, messages);
    return Response.json({ messages: updated, reply });
  } catch (err) {
    console.error("agent turn failed", err);
    return Response.json({ error: "Something went wrong talking to the agent." }, { status: 500 });
  }
}
