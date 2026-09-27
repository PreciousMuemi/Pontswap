// lib/recommendation/view.ts
//
// Converts server-side match/recommendation results into the small,
// serialisable shape the browser receives. Pure and testable.
//
// Only what the card displays crosses to the client: no escrow coordinates,
// no ineligible agents, no raw metadata. Every chip is derived from a "met"
// check or a scored signal on the matcher's own result — never from AI prose.

import type { AgentMatch, MatchRequest, MatchResult } from "@/lib/matching/agent-matching";
import type { Confidence, FallbackReason, Recommendation } from "./types";

export type AgentSummary = {
  pubkey: string;
  name: string | null;
  rank: number;
  score: number;
};

export type DiscoveryView =
  | { status: "invalid_request" }
  | { status: "no_agents_discovered" }
  | { status: "no_eligible_agents"; agentsFound: number }
  | { status: "eligible"; agentsFound: number; eligible: AgentSummary[] };

export type RecommendationView = {
  source: "ai" | "deterministic";
  fallbackReason: FallbackReason | null;
  confidence: Confidence;
  eligibleCount: number;
  recommended: (AgentSummary & { verified: string[] }) | null;
  reason: string;
  customerExplanation: string;
  supportingEvidence: string[];
  missingInformation: string[];
  alternatives: (AgentSummary & { verified: string[] })[];
};

// Display-only names for the customer's own request values.
const COUNTRY_LABEL: Record<string, string> = {
  KE: "Kenya", UG: "Uganda", TZ: "Tanzania", RW: "Rwanda", BI: "Burundi",
  NG: "Nigeria", GH: "Ghana", ZA: "South Africa", ZM: "Zambia", MW: "Malawi",
};
const PAYOUT_LABEL: Record<string, string> = { mpesa: "M-Pesa" };

export const countryLabel = (code: string) => COUNTRY_LABEL[code] ?? code;
export const payoutLabel = (method: string) =>
  PAYOUT_LABEL[method.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? method;

/** Short "✓" labels for what the matcher verified about this agent. */
export function verifiedLabels(m: AgentMatch, r: MatchRequest): string[] {
  const met = new Set(m.checks.filter((c) => c.status === "met").map((c) => c.requirement));
  const scored = new Set(m.score_breakdown.filter((s) => s.points > 0).map((s) => s.signal));
  const labels: string[] = [];
  if (met.has("destination_country")) labels.push(countryLabel(r.destination_country));
  if (met.has("destination_currency")) labels.push(r.destination_currency);
  if (met.has("payout_method")) labels.push(payoutLabel(r.payout_method));
  if (met.has("settlement")) labels.push(`${r.settlement_asset} settlement`);
  if (met.has("escrow")) labels.push("Escrow linked");
  if (scored.has("covers_origin_country")) labels.push(`Also in ${countryLabel(r.origin_country)}`);
  if (scored.has("accepts_origin_currency")) labels.push(`Accepts ${r.origin_currency}`);
  if (scored.has("declares_cross_border")) labels.push("Declares cross-border");
  if (scored.has("amount_within_limits")) labels.push("Amount within limits");
  return labels;
}

const summary = (m: AgentMatch): AgentSummary => ({
  pubkey: m.pubkey,
  name: m.name,
  rank: m.rank ?? 0,
  score: m.score,
});

export function toDiscoveryView(agentsFound: number, match: MatchResult): DiscoveryView {
  if (!agentsFound) return { status: "no_agents_discovered" };
  if (!match.eligible.length) return { status: "no_eligible_agents", agentsFound };
  return { status: "eligible", agentsFound, eligible: match.eligible.map(summary) };
}

export function toRecommendationView(rec: Recommendation): RecommendationView {
  const r = rec.match.request;
  const withVerified = (m: AgentMatch) => ({ ...summary(m), verified: verifiedLabels(m, r) });
  return {
    source: rec.source,
    fallbackReason: rec.fallback_reason,
    confidence: rec.confidence,
    eligibleCount: rec.match.eligible.length,
    recommended: rec.recommended_agent ? withVerified(rec.recommended_agent) : null,
    reason: rec.recommendation_reason,
    customerExplanation: rec.customer_explanation,
    supportingEvidence: rec.supporting_evidence,
    missingInformation: rec.missing_information,
    alternatives: rec.match.eligible
      .filter((m) => m.pubkey !== rec.recommended_pubkey)
      .map(withVerified),
  };
}
