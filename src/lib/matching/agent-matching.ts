// lib/matching/agent-matching.ts
//
// Deterministic agent matching for cross_border requests. Pure functions only:
// no relay access, no signing, no publishing, no swap mutation. Input is agent
// metadata already fetched by lib/pontmore/discovery.ts (kind 30360).
//
// Three separate stages:
//   1. ELIGIBILITY — hard requirements. An agent is eligible only if every one
//      is "met" from what its metadata explicitly declares.
//   2. RANKING     — soft signals that make an eligible agent more suitable.
//   3. EXPLANATION — a human-readable summary built from 1 and 2.
//
// Rules this module never breaks:
//   - A capability counts only if it is present in the agent's metadata.
//     Absent metadata is reported as "missing", never assumed.
//   - No exchange rates, fees, liquidity, or availability are invented. Amount
//     limits are compared only when they share a currency with a known amount.
//
// Real network data (checked against live relays) shapes the normalisation:
// limits are strings like "1000 KES" or unitless "500"/500; regions mix ISO
// codes ("KE") with country names ("Kenya", "KENYA") and non-countries
// ("Europe"); swap_types use hyphens ("fiat-to-btc").

import { z } from "zod";
import { AgentDefinitionContent } from "@/lib/pontmore/kinds";

// --- Request -------------------------------------------------------------

const AmountString = z.string().regex(/^\d+(\.\d+)?$/);

/**
 * What the customer wants. Field names mirror CrossBorderView (kinds.ts) so a
 * corridor maps across directly.
 */
export const MatchRequestSchema = z.object({
  origin_country: z.string().regex(/^[A-Z]{2}$/),
  destination_country: z.string().regex(/^[A-Z]{2}$/),
  origin_currency: z.string().min(3).max(8),
  destination_currency: z.string().min(3).max(8),
  amount: AmountString, // in origin_currency
  destination_amount: AmountString.optional(), // only once a quote exists
  payout_method: z.string().min(1),
  settlement_asset: z.enum(["BTC"]),
  settlement_network: z.string().min(1).optional(), // e.g. lightning
});
export type MatchRequest = z.infer<typeof MatchRequestSchema>;

/**
 * Minimal agent shape. AgentDefinition from discovery.ts satisfies it; content
 * is re-validated here so malformed metadata is rejected, not trusted.
 */
export type AgentCandidate = {
  pubkey: string;
  content: unknown;
  escrowReference?: string | null;
  createdAt?: number;
};

// --- Result --------------------------------------------------------------

export type Requirement =
  | "metadata"
  | "destination_country"
  | "destination_currency"
  | "payout_method"
  | "settlement"
  | "escrow"
  | "amount_limits";

/** met: declared and satisfied. unmet: declared and contradicted. missing: not declared / not comparable. */
export type CheckStatus = "met" | "unmet" | "missing";

export type RequirementCheck = {
  requirement: Requirement;
  status: CheckStatus;
  detail: string;
};

export type RankingSignal =
  | "declares_cross_border"
  | "covers_origin_country"
  | "accepts_origin_currency"
  | "amount_within_limits";

export type ScoreItem = {
  signal: RankingSignal;
  points: number;
  max: number;
  detail: string;
};

export type AgentMatch = {
  pubkey: string;
  name: string | null;
  eligible: boolean;
  /** 1-based position among eligible agents; null if ineligible. */
  rank: number | null;
  /** 0–100 suitability; 0 when ineligible. Sum of score_breakdown points. */
  score: number;
  score_breakdown: ScoreItem[];
  checks: RequirementCheck[];
  matched_capabilities: string[];
  unmet_requirements: string[];
  missing_information: string[];
  explanation: string;
};

export type MatchResult = {
  request: MatchRequest;
  /** Eligible agents, best first. */
  eligible: AgentMatch[];
  ineligible: AgentMatch[];
};

/** Ranking weights. Only applied to eligible agents; they sum to 100. */
export const WEIGHTS: Readonly<Record<RankingSignal, number>> = {
  declares_cross_border: 30,
  covers_origin_country: 25,
  accepts_origin_currency: 25,
  amount_within_limits: 20,
};

const HARD_REQUIREMENTS: readonly Requirement[] = [
  "metadata",
  "destination_country",
  "destination_currency",
  "payout_method",
  "settlement",
  "escrow",
];

// --- Normalisation (string matching only, never capability inference) ----

/** "M-Pesa" / "m_pesa" / "mpesa" -> "mpesa"; "cross_border" / "cross-border" -> "crossborder". */
const token = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const code = (s: string) => s.trim().toUpperCase();

/**
 * Country-name spellings seen on the network (or likely for nearby
 * corridors), mapped to ISO 3166-1 alpha-2. This is spelling normalisation:
 * "Kenya" and "KE" name the same country. Anything not listed here — including
 * regions like "Europe" — is left uninterpreted, never expanded.
 */
const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  kenya: "KE",
  uganda: "UG",
  tanzania: "TZ",
  rwanda: "RW",
  burundi: "BI",
  southsudan: "SS",
  ethiopia: "ET",
  nigeria: "NG",
  ghana: "GH",
  southafrica: "ZA",
  zambia: "ZM",
  malawi: "MW",
};

/** Region entry -> ISO code, or null if it is not a recognisable country. */
function regionToCountry(region: string): string | null {
  const trimmed = region.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_NAMES[token(trimmed)] ?? null;
}

/** Networks that settle in BTC. The only settlement asset in the protocol. */
const BTC_NETWORKS = new Set(["bitcoin", "btc", "onchain", "lightning", "ln"]);

type Limit = { amount: number; currency: string | null };

/** Parse "1000 KES", "KES 1000", "1,000", "500" or 500. Null if unparseable. */
export function parseLimit(value: unknown): Limit | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? { amount: value, currency: null }
      : null;
  }
  if (typeof value !== "string") return null;
  const s = value.trim().replace(/,/g, "");
  const numFirst = s.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]{3,8})?$/);
  const curFirst = s.match(/^([A-Za-z]{3,8})\s*(\d+(?:\.\d+)?)$/);
  const amountStr = numFirst?.[1] ?? curFirst?.[2];
  const currency = numFirst ? numFirst[2] : curFirst?.[1];
  if (!amountStr) return null;
  return { amount: Number(amountStr), currency: currency ? currency.toUpperCase() : null };
}

// --- Stage 1: eligibility -----------------------------------------------

type Caps = AgentDefinitionContent["capabilities"];

function checkDestinationCountry(caps: Caps, req: MatchRequest): RequirementCheck {
  const regions = caps.regions?.length
    ? caps.regions
    : caps.region
      ? [caps.region]
      : [];
  if (!regions.length) {
    return { requirement: "destination_country", status: "missing", detail: "agent declares no regions" };
  }
  const resolved = regions.map(regionToCountry);
  if (resolved.includes(req.destination_country)) {
    return { requirement: "destination_country", status: "met", detail: `operates in ${req.destination_country}` };
  }
  const uninterpreted = regions.filter((_, i) => resolved[i] === null);
  if (uninterpreted.length) {
    return {
      requirement: "destination_country",
      status: "missing",
      detail: `regions ${JSON.stringify(uninterpreted)} are not country codes; cannot confirm ${req.destination_country}`,
    };
  }
  return {
    requirement: "destination_country",
    status: "unmet",
    detail: `operates in ${regions.join(", ")}, not ${req.destination_country}`,
  };
}

function checkListed(
  requirement: Requirement,
  declared: string[] | undefined,
  wanted: string,
  norm: (s: string) => string,
  noun: { one: string; many: string },
): RequirementCheck {
  if (!declared?.length) {
    return { requirement, status: "missing", detail: `agent declares no ${noun.many}` };
  }
  if (declared.some((d) => norm(d) === norm(wanted))) {
    return { requirement, status: "met", detail: `supports ${noun.one} ${wanted}` };
  }
  return {
    requirement,
    status: "unmet",
    detail: `${noun.many} ${declared.join(", ")} do not include ${wanted}`,
  };
}

function checkSettlement(caps: Caps, req: MatchRequest): RequirementCheck {
  const nets = caps.settlement_networks ?? [];
  if (!nets.length) {
    return { requirement: "settlement", status: "missing", detail: "agent declares no settlement networks" };
  }
  if (req.settlement_network) {
    const ok = nets.some((n) => token(n) === token(req.settlement_network!));
    return ok
      ? { requirement: "settlement", status: "met", detail: `settles ${req.settlement_asset} on ${req.settlement_network}` }
      : { requirement: "settlement", status: "unmet", detail: `settlement networks ${nets.join(", ")} do not include ${req.settlement_network}` };
  }
  const btc = nets.filter((n) => BTC_NETWORKS.has(token(n)));
  return btc.length
    ? { requirement: "settlement", status: "met", detail: `settles ${req.settlement_asset} (${btc.join(", ")})` }
    : { requirement: "settlement", status: "unmet", detail: `settlement networks ${nets.join(", ")} are not ${req.settlement_asset} networks` };
}

function checkEscrow(agent: AgentCandidate): RequirementCheck {
  return agent.escrowReference
    ? { requirement: "escrow", status: "met", detail: "escrow descriptor linked" }
    : { requirement: "escrow", status: "unmet", detail: "no escrow descriptor linked; a swap cannot be opened" };
}

/**
 * Compare request amounts against min/max, but only where the limit's currency
 * matches a currency we hold an amount in. No conversion, ever.
 */
function checkLimits(caps: Caps, req: MatchRequest): RequirementCheck {
  const limits = caps.limits;
  if (!limits || (limits.min == null && limits.max == null)) {
    return { requirement: "amount_limits", status: "missing", detail: "agent declares no amount limits" };
  }

  const known: Record<string, number> = { [code(req.origin_currency)]: Number(req.amount) };
  if (req.destination_amount) known[code(req.destination_currency)] = Number(req.destination_amount);
  const knownLabel = Object.entries(known).map(([c, a]) => `${a} ${c}`).join(" / ");

  const problems: string[] = [];
  const verified: string[] = [];
  const unknown: string[] = [];

  for (const bound of ["min", "max"] as const) {
    const raw = limits[bound];
    if (raw == null) continue;
    const limit = parseLimit(raw);
    if (!limit) {
      unknown.push(`${bound} ${JSON.stringify(raw)} is not a readable amount`);
      continue;
    }
    if (!limit.currency) {
      unknown.push(`${bound} ${limit.amount} has no currency`);
      continue;
    }
    const amount = known[limit.currency];
    if (amount === undefined) {
      unknown.push(
        `${bound} is in ${limit.currency}; request is ${knownLabel} and no quote converts it`,
      );
      continue;
    }
    const label = `${amount} ${limit.currency}`;
    if (bound === "min" && amount < limit.amount) problems.push(`${label} is below minimum ${limit.amount} ${limit.currency}`);
    else if (bound === "max" && amount > limit.amount) problems.push(`${label} is above maximum ${limit.amount} ${limit.currency}`);
    else verified.push(`${label} within ${bound} ${limit.amount} ${limit.currency}`);
  }

  if (problems.length) return { requirement: "amount_limits", status: "unmet", detail: problems.join("; ") };
  if (unknown.length) return { requirement: "amount_limits", status: "missing", detail: unknown.join("; ") };
  return { requirement: "amount_limits", status: "met", detail: verified.join("; ") };
}

// --- Stage 2: ranking ----------------------------------------------------

function rank(caps: Caps, req: MatchRequest, limits: RequirementCheck): ScoreItem[] {
  const items: ScoreItem[] = [];
  const add = (signal: RankingSignal, hit: boolean, detail: string) =>
    items.push({ signal, points: hit ? WEIGHTS[signal] : 0, max: WEIGHTS[signal], detail });

  const types = caps.swap_types ?? [];
  const crossBorder = types.some((t) => token(t) === "crossborder");
  add(
    "declares_cross_border",
    crossBorder,
    crossBorder
      ? "explicitly declares cross-border swaps"
      : types.length
        ? `declares swap types ${types.join(", ")} but not cross-border`
        : "declares no swap types",
  );

  const regions = caps.regions?.length ? caps.regions : caps.region ? [caps.region] : [];
  const origin = regions.map(regionToCountry).includes(req.origin_country);
  add(
    "covers_origin_country",
    origin,
    origin ? `also operates in origin ${req.origin_country}` : `does not list origin ${req.origin_country}`,
  );

  const currencies = caps.fiat_currencies ?? [];
  const originCur = currencies.some((c) => code(c) === code(req.origin_currency));
  add(
    "accepts_origin_currency",
    originCur,
    originCur ? `also accepts origin currency ${req.origin_currency}` : `does not list origin currency ${req.origin_currency}`,
  );

  add(
    "amount_within_limits",
    limits.status === "met",
    limits.status === "met" ? `amount verified: ${limits.detail}` : "amount not verified against limits",
  );
  return items;
}

// --- Stage 3: explanation -----------------------------------------------

function explain(m: Omit<AgentMatch, "explanation" | "rank">): string {
  const who = m.name ?? `agent ${m.pubkey.slice(0, 8)}`;
  if (!m.eligible) {
    const blockers = m.checks
      .filter((c) => c.status === "unmet" || (c.status === "missing" && HARD_REQUIREMENTS.includes(c.requirement)))
      .map((c) => (c.status === "missing" ? `not declared — ${c.detail}` : c.detail));
    return `${who} is not eligible: ${blockers.join("; ")}.`;
  }
  const strengths = m.score_breakdown.filter((s) => s.points > 0).map((s) => s.detail);
  const parts = [
    `${who} is eligible: ${m.matched_capabilities.join(", ")}.`,
    strengths.length ? `Ranked up because it ${strengths.join("; ")}.` : "It meets the requirements but shows no additional suitability signals.",
  ];
  if (m.missing_information.length) parts.push(`Not verified: ${m.missing_information.join("; ")}.`);
  return parts.join(" ");
}

// --- Entry point ---------------------------------------------------------

/** Evaluate one agent. Never throws on bad agent metadata. */
export function evaluateAgent(agent: AgentCandidate, req: MatchRequest): AgentMatch {
  const parsed = AgentDefinitionContent.safeParse(agent.content);
  const validPubkey = typeof agent.pubkey === "string" && /^[0-9a-f]{64}$/i.test(agent.pubkey);

  if (!parsed.success || !validPubkey) {
    const detail = !validPubkey
      ? "agent pubkey is not a 64-char hex key"
      : `agent metadata failed validation (${parsed.error?.issues[0]?.path.join(".") || "content"})`;
    const base = {
      pubkey: String(agent.pubkey ?? ""),
      name: null,
      eligible: false,
      score: 0,
      score_breakdown: [],
      checks: [{ requirement: "metadata" as const, status: "unmet" as const, detail }],
      matched_capabilities: [],
      unmet_requirements: [detail],
      missing_information: [],
    };
    return { ...base, rank: null, explanation: explain(base) };
  }

  const content = parsed.data;
  const caps = content.capabilities;
  const limits = checkLimits(caps, req);
  const checks: RequirementCheck[] = [
    { requirement: "metadata", status: "met", detail: "metadata is valid" },
    checkDestinationCountry(caps, req),
    checkListed("destination_currency", caps.fiat_currencies, req.destination_currency, code, { one: "fiat currency", many: "fiat currencies" }),
    checkListed("payout_method", caps.payment_channels, req.payout_method, token, { one: "payment channel", many: "payment channels" }),
    checkSettlement(caps, req),
    checkEscrow(agent),
    limits,
  ];

  // Hard requirements must be met. Limits block only when a comparable limit
  // is actually violated; unverifiable limits are reported, not assumed.
  const eligible =
    checks.filter((c) => HARD_REQUIREMENTS.includes(c.requirement)).every((c) => c.status === "met") &&
    limits.status !== "unmet";

  const score_breakdown = eligible ? rank(caps, req, limits) : [];
  const missing_information = [
    ...checks.filter((c) => c.status === "missing").map((c) => c.detail),
    ...score_breakdown.filter((s) => s.points === 0 && s.signal !== "amount_within_limits").map((s) => s.detail),
  ];

  const base = {
    pubkey: agent.pubkey,
    name: content.name,
    eligible,
    score: score_breakdown.reduce((n, s) => n + s.points, 0),
    score_breakdown,
    checks,
    matched_capabilities: checks.filter((c) => c.status === "met" && c.requirement !== "metadata").map((c) => c.detail),
    unmet_requirements: checks.filter((c) => c.status === "unmet").map((c) => c.detail),
    missing_information,
  };
  return { ...base, rank: null, explanation: explain(base) };
}

/**
 * Evaluate and rank agents for a request. Throws if the request itself is
 * invalid; bad agent metadata is reported per agent instead.
 *
 * Ranking order: score, then fewer missing items, then fresher metadata
 * (createdAt), then pubkey — fully deterministic for the same input.
 */
export function matchAgents(request: MatchRequest, agents: readonly AgentCandidate[]): MatchResult {
  const req = MatchRequestSchema.parse(request);
  const created = new Map(agents.map((a) => [a.pubkey, a.createdAt ?? 0]));
  const all = agents.map((a) => evaluateAgent(a, req));

  const eligible = all
    .filter((m) => m.eligible)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.missing_information.length - b.missing_information.length ||
        (created.get(b.pubkey) ?? 0) - (created.get(a.pubkey) ?? 0) ||
        a.pubkey.localeCompare(b.pubkey),
    )
    .map((m, i) => ({ ...m, rank: i + 1 }));

  const ineligible = all
    .filter((m) => !m.eligible)
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey));

  return { request: req, eligible, ineligible };
}
