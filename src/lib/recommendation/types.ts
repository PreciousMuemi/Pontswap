// lib/recommendation/types.ts
//
// Provider-agnostic contract for AI agent recommendation. Nothing here knows
// about a specific AI vendor; providers live in ./providers and are injected.
//
// The deterministic matcher (lib/matching) stays authoritative for
// eligibility. AI only chooses among eligible agents and explains the choice,
// citing evidence by ID from what it was given — never free-form capability
// claims.

import { z } from "zod";
import type { AgentMatch, MatchRequest, MatchResult } from "@/lib/matching/agent-matching";

export const CONFIDENCE_LEVELS = ["high", "medium", "limited"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

// --- What the AI receives -----------------------------------------------

/** One citable fact about a candidate. `id` is what the AI must cite. */
export type EvidenceItem = { id: string; text: string };

export type AiCandidate = {
  pubkey: string;
  name: string | null;
  rank: number;
  score: number; // 0–100 from the deterministic ranking
  /** Satisfied requirements and positive ranking signals. */
  evidence: EvidenceItem[];
  /** Undeclared or unverifiable facts. */
  missing: EvidenceItem[];
};

/**
 * Everything the AI sees — and nothing more. No customer identity, no
 * recipient details, no payment instructions, no ineligible agents.
 */
export type AiRecommendationInput = {
  request: {
    origin_country: string;
    destination_country: string;
    origin_currency: string;
    destination_currency: string;
    amount: string;
    destination_amount: string | null; // null = pending a quote
    payout_method: string;
    settlement_asset: string;
    settlement_network: string | null;
  };
  /** True when the top deterministic scores are tied. */
  ranking_is_tied: boolean;
  candidates: AiCandidate[];
};

// --- What the AI must return --------------------------------------------

/**
 * Strict schema for the AI's answer. Built per request so pubkeys and
 * evidence IDs are enums of exactly what was supplied.
 */
export function aiOutputSchema(input: AiRecommendationInput) {
  const pubkeys = input.candidates.map((c) => c.pubkey);
  const evidenceIds = input.candidates.flatMap((c) => c.evidence.map((e) => e.id));
  const missingIds = input.candidates.flatMap((c) => c.missing.map((e) => e.id));
  // z.enum needs a non-empty tuple; a sentinel keeps the schema valid when a
  // list is empty, and validation rejects it if the AI ever returns it.
  const nonEmpty = (xs: string[]) => (xs.length ? xs : ["__none__"]) as [string, ...string[]];

  return z
    .object({
      recommended_pubkey: z.enum(nonEmpty(pubkeys)),
      recommendation_reason: z.string().min(1).max(300),
      supporting_evidence_ids: z.array(z.enum(nonEmpty(evidenceIds))).min(1).max(8),
      missing_information_ids: z.array(z.enum(nonEmpty(missingIds))).max(8),
      evidence_sufficient_to_distinguish: z.boolean(),
      confidence: z.enum(CONFIDENCE_LEVELS),
      customer_explanation: z.string().min(1).max(400),
    })
    .strict();
}
export type AiRecommendationOutput = z.infer<ReturnType<typeof aiOutputSchema>>;

// --- Provider interface -------------------------------------------------

/**
 * Any AI backend. Returns the raw structured object; the caller validates it,
 * so a provider can never bypass validation. Providers receive only
 * AiRecommendationInput — no signer, relay, or swap handle.
 */
export interface RecommendationProvider {
  readonly name: string;
  recommend(
    input: AiRecommendationInput,
    opts: { signal: AbortSignal },
  ): Promise<unknown>;
}

/** Thrown by providers when credentials are absent. */
export class MissingCredentialsError extends Error {
  constructor(message = "AI provider credentials are not configured") {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

// --- What the application receives --------------------------------------

export type FallbackReason =
  | "no_provider"
  | "missing_credentials"
  | "timeout"
  | "provider_error"
  | "invalid_response"
  | "no_agents_discovered" // discovery returned nothing (e.g. relays unreachable)
  | "no_eligible_agents";

export type Recommendation = {
  /** "ai" only when a validated AI answer was accepted. */
  source: "ai" | "deterministic";
  /** null only when no agent is eligible. */
  recommended_pubkey: string | null;
  recommended_agent: AgentMatch | null;
  recommendation_reason: string;
  supporting_evidence: string[];
  missing_information: string[];
  confidence: Confidence;
  customer_explanation: string;
  /** Set whenever source is "deterministic". */
  fallback_reason: FallbackReason | null;
  /** The authoritative deterministic result, always present. */
  match: MatchResult;
};

export type { MatchRequest };
