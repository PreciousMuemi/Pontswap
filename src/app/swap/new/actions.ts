"use server";

// Server Actions for the cross-border agent recommendation on /swap/new.
//
// These are reachable by direct POST, so every input is re-validated here and
// only sanitised view data is returned. They read public relay data and call
// the AI provider; they never sign, publish, or change a swap.

import { MatchRequestSchema } from "@/lib/matching/agent-matching";
import {
  matchAgentsForRequest,
  recommendAgentForRequest,
} from "@/lib/recommendation/server";
import {
  toDiscoveryView,
  toRecommendationView,
  type DiscoveryView,
  type RecommendationView,
} from "@/lib/recommendation/view";

/** Step 1: discover agents and apply the deterministic eligibility filter. */
export async function discoverEligibleAgents(input: unknown): Promise<DiscoveryView> {
  const parsed = MatchRequestSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid_request" };
  const { agentsFound, match } = await matchAgentsForRequest(parsed.data);
  return toDiscoveryView(agentsFound, match);
}

/** Step 2: AI recommendation among eligible agents, or deterministic fallback. */
export async function recommendEligibleAgent(
  input: unknown,
): Promise<RecommendationView | { status: "invalid_request" }> {
  const parsed = MatchRequestSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid_request" };
  return toRecommendationView(await recommendAgentForRequest(parsed.data));
}
