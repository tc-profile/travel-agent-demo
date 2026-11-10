/**
 * Entry point for the chat agent. The single monolithic agent has been replaced by a multi-agent
 * system in ./agents (router → specialists → synthesizer → guardrails + self-evaluation); see
 * ./agents/orchestrator.ts for the flow and README.md's "Multi-agent architecture" section.
 */
export { runAgentTurn, type AgentTurnResult, type TurnOutcome } from "./agents/orchestrator";
