// lib/recommendation/recommend.ts
//
// cross-border request -> deterministic eligibility/ranking (authoritative)
//                      -> optional AI recommendation (validated)
//                      -> deterministic fallback on any AI problem
//
// Pure orchestration: the provider is injected, and this module imports
// nothing that can sign, publish, or mutate a swap. The customer still
// approves and opens the swap through the existing flow.

import {
  matchAgents,
  type AgentCandidate,
  type AgentMatch,
  type MatchRequest,
  type MatchResult,
} from "@/lib/matching/agent-matching";
import {
  aiOutputSchema,
  MissingCredentialsError,
  type AiCandidate,
  type AiRecommendationInput,
  type Confidence,
  type FallbackReason,
  type Recommendation,
  type RecommendationProvider,
} from "./types";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const FALLBACK_REASON_TEXT =
  "Recommended based on published capabilities. AI recommendation unavailable.";

const MAX_TEXT = 200; // cap third-party strings passed to the AI
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- Input construction -------------------------------------------------

/** Evidence the AI may cite for one eligible agent, with stable IDs. */
function toAiCandidate(m: AgentMatch): AiCandidate {
  const prefix = `A${m.rank}`;
  const facts = [
    ...m.matched_capabilities,
    ...m.score_breakdown.filter((s) => s.points > 0).map((s) => s.detail),
  ];
  return {
    pubkey: m.pubkey,
    name: m.name ? clip(m.name, 80) : null,
    rank: m.rank!,
    score: m.score,
    evidence: facts.map((text, i) => ({ id: `${prefix}.E${i + 1}`, text: clip(text) })),
    missing: m.missing_information.map((text, i) => ({ id: `${prefix}.M${i + 1}`, text: clip(text) })),
  };
}

export function isRankingTied(match: MatchResult): boolean {
  const [a, b] = match.eligible;
  return !!a && !!b && a.score === b.score;
}

/** Build exactly what the AI sees. Eligible agents only; no identities. */
export function buildAiInput(match: MatchResult): AiRecommendationInput {
  const r = match.request;
  return {
    request: {
      origin_country: r.origin_country,
      destination_country: r.destination_country,
      origin_currency: r.origin_currency,
      destination_currency: r.destination_currency,
      amount: r.amount,
      destination_amount: r.destination_amount ?? null,
      payout_method: r.payout_method,
      settlement_asset: r.settlement_asset,
      settlement_network: r.settlement_network ?? null,
    },
    ranking_is_tied: isRankingTied(match),
    candidates: match.eligible.map(toAiCandidate),
  };
}

// --- Output validation --------------------------------------------------

type Validated =
  | { ok: true; recommendation: Omit<Recommendation, "match"> }
  | { ok: false; error: string };

/**
 * Topics the input never contains, so any mention is invented. The system
 * prompt tells the model not to raise them at all, which makes this checkable.
 */
const UNSUPPORTED_CLAIMS =
  /\b(fees?|commissions?|spreads?|exchange rates?|rates?|liquidity|availab(?:le|ility)|online|instant(?:ly)?|cheap(?:er|est)?|fast(?:er|est)?|guarantee[ds]?|completed|released|funded|refunded)\b/gi;

const EVIDENCE_ID = /\bA\d+\.[EM]\d+\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (s: string) =>
  new Set((s.replace(EVIDENCE_ID, "").match(NUMBER) ?? []).map((n) => n.replace(/,/g, "")));

/**
 * Checks AI prose without trying to understand it: every number and
 * currency-like code must already appear in the input, and none of the
 * never-supplied topics may be mentioned. Catches invented rates, fees,
 * amounts, currencies, availability, and status.
 */
function unsupportedTokens(text: string, inputJson: string): string[] {
  const known = numbersIn(inputJson);
  const numbers = [...numbersIn(text)].filter((n) => !known.has(n));
  const codes = (text.match(/\b[A-Z]{3}\b/g) ?? []).filter(
    (c) => !new RegExp(`\\b${c}\\b`).test(inputJson),
  );
  const claims = text.match(UNSUPPORTED_CLAIMS) ?? [];
  return [...numbers, ...codes, ...claims];
}

export function validateAiOutput(
  raw: unknown,
  input: AiRecommendationInput,
  match: MatchResult,
): Validated {
  const parsed = aiOutputSchema(input).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `schema: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}` };
  }
  const out = parsed.data;

  // Eligibility is the matcher's call, never the AI's.
  const agent = match.eligible.find((m) => m.pubkey === out.recommended_pubkey);
  if (!agent) return { ok: false, error: "recommended agent is not eligible" };

  const candidate = input.candidates.find((c) => c.pubkey === agent.pubkey)!;
  const evidence = new Map(candidate.evidence.map((e) => [e.id, e.text]));
  const missing = new Map(candidate.missing.map((e) => [e.id, e.text]));

  // Evidence must belong to the recommended agent — no borrowing another
  // agent's capabilities.
  const foreignEvidence = out.supporting_evidence_ids.filter((id) => !evidence.has(id));
  if (foreignEvidence.length) return { ok: false, error: `evidence not about this agent: ${foreignEvidence.join(", ")}` };
  const foreignMissing = out.missing_information_ids.filter((id) => !missing.has(id));
  if (foreignMissing.length) return { ok: false, error: `missing-info not about this agent: ${foreignMissing.join(", ")}` };

  const inputJson = JSON.stringify(input);
  for (const field of ["recommendation_reason", "customer_explanation"] as const) {
    const bad = unsupportedTokens(out[field], inputJson);
    if (bad.length) return { ok: false, error: `${field} states facts not in the input: ${bad.join(", ")}` };
  }

  // Confidence cannot exceed what the evidence supports.
  const confidence: Confidence =
    !out.evidence_sufficient_to_distinguish || input.ranking_is_tied ? "limited" : out.confidence;

  return {
    ok: true,
    recommendation: {
      source: "ai",
      recommended_pubkey: agent.pubkey,
      recommended_agent: agent,
      recommendation_reason: out.recommendation_reason,
      supporting_evidence: [...new Set(out.supporting_evidence_ids)].map((id) => evidence.get(id)!),
      missing_information: [...new Set(out.missing_information_ids)].map((id) => missing.get(id)!),
      confidence,
      customer_explanation: out.customer_explanation,
      fallback_reason: null,
    },
  };
}

// --- Deterministic fallback ---------------------------------------------

export function deterministicConfidence(match: MatchResult): Confidence {
  const top = match.eligible[0];
  if (!top || isRankingTied(match)) return "limited";
  if (top.score >= 75) return "high";
  if (top.score >= 50) return "medium";
  return "limited";
}

export function deterministicRecommendation(
  match: MatchResult,
  reason: FallbackReason,
): Recommendation {
  const top = match.eligible[0];
  const r = match.request;
  if (!top) {
    // Distinguish "nothing loaded" from "nothing matched" — only the latter
    // says anything about what agents publish.
    const discovered = reason !== "no_agents_discovered";
    return {
      source: "deterministic",
      recommended_pubkey: null,
      recommended_agent: null,
      recommendation_reason: discovered
        ? "No agent's published capabilities satisfy this request."
        : "No agents could be loaded from the network.",
      supporting_evidence: [],
      missing_information: [],
      confidence: "limited",
      customer_explanation: discovered
        ? `No agent currently publishes everything needed for ${r.origin_country} → ${r.destination_country} payouts in ${r.destination_currency} via ${r.payout_method}. You can try again later.`
        : "We couldn't load agents from the network right now. Please try again in a moment.",
      fallback_reason: discovered ? "no_eligible_agents" : "no_agents_discovered",
      match,
    };
  }
  const who = top.name ?? "This agent";
  return {
    source: "deterministic",
    recommended_pubkey: top.pubkey,
    recommended_agent: top,
    recommendation_reason: FALLBACK_REASON_TEXT,
    supporting_evidence: [
      ...top.matched_capabilities,
      ...top.score_breakdown.filter((s) => s.points > 0).map((s) => s.detail),
    ],
    missing_information: top.missing_information,
    confidence: deterministicConfidence(match),
    customer_explanation:
      `${who} is the top match based on what agents publish about themselves.` +
      (top.missing_information.length ? " Some details could not be verified from that information." : ""),
    fallback_reason: reason,
    match,
  };
}

// --- Entry point --------------------------------------------------------

class TimeoutError extends Error {}

export type RecommendOptions = {
  /** null/undefined -> deterministic only. */
  provider?: RecommendationProvider | null;
  timeoutMs?: number;
  /** Receives the reason whenever AI output is not used. Never throws. */
  onFallback?: (reason: FallbackReason, detail?: string) => void;
};

/**
 * Recommend one eligible agent. Always resolves with a usable result unless
 * the request itself is invalid (that throws, as in matchAgents). AI failure
 * of any kind yields the deterministic recommendation instead.
 */
export async function recommendAgent(
  request: MatchRequest,
  agents: readonly AgentCandidate[],
  opts: RecommendOptions = {},
): Promise<Recommendation> {
  const match = matchAgents(request, agents);
  const fallback = (reason: FallbackReason, detail?: string) => {
    try {
      opts.onFallback?.(reason, detail);
    } catch {
      /* observers must not break recommendations */
    }
    return deterministicRecommendation(match, reason);
  };

  if (!agents.length) return fallback("no_agents_discovered");
  if (!match.eligible.length) return fallback("no_eligible_agents");
  if (!opts.provider) return fallback("no_provider");

  const input = buildAiInput(match);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  let raw: unknown;
  try {
    raw = await Promise.race([
      opts.provider.recommend(input, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError());
        }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (err instanceof MissingCredentialsError) return fallback("missing_credentials", err.message);
    if (err instanceof TimeoutError) return fallback("timeout");
    return fallback("provider_error", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  const validated = validateAiOutput(raw, input, match);
  if (!validated.ok) return fallback("invalid_response", validated.error);
  return { ...validated.recommendation, match };
}
