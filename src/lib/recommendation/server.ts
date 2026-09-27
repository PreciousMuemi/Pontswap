// lib/recommendation/server.ts
//
// Server entry point the UI can call later (e.g. from a Server Action).
// Server-only: this is where credentials are read and the provider is built.
//
// Agent metadata is fetched from the relays here, on the server, rather than
// accepted from the browser — the matcher and AI only ever see what agents
// actually published.

import "server-only";
import { fetchAgents } from "@/lib/pontmore/discovery";
import type { MatchRequest } from "@/lib/matching/agent-matching";
import { readAiConfig } from "./config";
import { recommendAgent } from "./recommend";
import { createAnthropicProvider } from "./providers/anthropic";
import { MissingCredentialsError, type Recommendation, type RecommendationProvider } from "./types";

/** Stand-in used when credentials are absent, so the reason is reported. */
const missingCredentialsProvider: RecommendationProvider = {
  name: "unconfigured",
  recommend: async () => {
    throw new MissingCredentialsError();
  },
};

export async function recommendAgentForRequest(request: MatchRequest): Promise<Recommendation> {
  const agents = await fetchAgents();
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
