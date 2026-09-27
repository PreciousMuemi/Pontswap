// lib/recommendation/server.ts
//
// Server entry point the UI calls (via Server Actions in app/swap/new).
// Server-only: this is where credentials are read and the provider is built.
//
// Agent metadata is fetched from the relays here, on the server, rather than
// accepted from the browser — the matcher and AI only ever see what agents
// actually published.

import "server-only";
import { fetchAgents, type AgentDefinition } from "@/lib/pontmore/discovery";
import { matchAgents, type MatchRequest, type MatchResult } from "@/lib/matching/agent-matching";
import { readAiConfig } from "./config";
import { recommendAgent } from "./recommend";
import { createAnthropicProvider } from "./providers/anthropic";
import { MissingCredentialsError, type Recommendation, type RecommendationProvider } from "./types";

/**
 * Short-lived cache so the UI's "discover" and "recommend" steps see the same
 * agent set without querying the relays twice. Empty results are not cached:
 * they usually mean the relays were unreachable, and a retry should retry.
 */
const AGENT_CACHE_MS = 60_000;
let agentCache: { at: number; agents: AgentDefinition[] } | null = null;

export async function discoverAgents(): Promise<AgentDefinition[]> {
  if (agentCache && Date.now() - agentCache.at < AGENT_CACHE_MS) return agentCache.agents;
  const agents = await fetchAgents();
  agentCache = agents.length ? { at: Date.now(), agents } : null;
  return agents;
}

/** Deterministic step only — no AI. */
export async function matchAgentsForRequest(
  request: MatchRequest,
): Promise<{ agentsFound: number; match: MatchResult }> {
  const agents = await discoverAgents();
  return { agentsFound: agents.length, match: matchAgents(request, agents) };
}

/** Stand-in used when credentials are absent, so the reason is reported. */
const missingCredentialsProvider: RecommendationProvider = {
  name: "unconfigured",
  recommend: async () => {
    throw new MissingCredentialsError();
  },
};

export async function recommendAgentForRequest(request: MatchRequest): Promise<Recommendation> {
  const agents = await discoverAgents();
  const cfg = readAiConfig(process.env);

  if (!cfg.ok) {
    return recommendAgent(request, agents, {
      provider: cfg.reason === "missing_credentials" ? missingCredentialsProvider : null,
    });
  }
  return recommendAgent(request, agents, {
    provider: createAnthropicProvider(cfg.config),
    timeoutMs: cfg.config.timeoutMs,
  });
}
