// Run with: npm test — the AI provider is always mocked; no network calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchAgents, type AgentCandidate, type MatchRequest } from "@/lib/matching/agent-matching";
import {
  recommendAgent,
  buildAiInput,
  FALLBACK_REASON_TEXT,
} from "./recommend";
import { readAiConfig, DEFAULT_MODEL } from "./config";
import {
  MissingCredentialsError,
  type AiRecommendationInput,
  type FallbackReason,
  type RecommendationProvider,
} from "./types";
import { SwapRequestContent } from "@/lib/pontmore/kinds";
import { FIAT_TO_BTC_TRANSITIONS, replayTransitions } from "@/lib/pontmore/states";

// --- Fixtures -----------------------------------------------------------

const UG_KE: MatchRequest = {
  origin_country: "UG",
  destination_country: "KE",
  origin_currency: "UGX",
  destination_currency: "KES",
  amount: "100000",
  payout_method: "mpesa",
  settlement_asset: "BTC",
};

const pk = (c: string) => c.repeat(64);
function agent(id: string, caps: Record<string, unknown>): AgentCandidate {
  const pubkey = pk(id);
  return {
    pubkey,
    escrowReference: `30361:${pubkey}:escrow`,
    createdAt: 1_700_000_000,
    content: { name: `Agent ${id}`, capabilities: caps },
  };
}

const PERFECT = agent("a", {
  swap_types: ["cross_border"],
  regions: ["UG", "KE"],
  fiat_currencies: ["UGX", "KES"],
  payment_channels: ["mpesa"],
  settlement_networks: ["lightning"],
  limits: { min: "50000 UGX", max: "5000000 UGX" },
});
const KENYA_ONLY = agent("b", {
  swap_types: ["fiat-to-btc"],
  regions: ["KE"],
  fiat_currencies: ["KES"],
  payment_channels: ["mpesa"],
  settlement_networks: ["bitcoin", "lightning"],
  limits: { min: "1000 KES", max: "500000 KES" },
});
const EAST_AFRICA = agent("c", {
  regions: ["Kenya", "Uganda"],
  fiat_currencies: ["KES", "UGX"],
  payment_channels: ["M-Pesa"],
  settlement_networks: ["lightning"],
});
const WRONG_COUNTRY = agent("d", {
  regions: ["NG"],
  fiat_currencies: ["NGN", "KES"],
  payment_channels: ["mpesa"],
  settlement_networks: ["lightning"],
});
const AGENTS = [KENYA_ONLY, WRONG_COUNTRY, EAST_AFRICA, PERFECT];

// --- Helpers ------------------------------------------------------------

type Call = { input: AiRecommendationInput; signal: AbortSignal };

function mockProvider(
  respond: (input: AiRecommendationInput, signal: AbortSignal) => unknown,
  calls: Call[] = [],
): RecommendationProvider {
  return {
    name: "mock",
    recommend: async (input, { signal }) => {
      calls.push({ input, signal });
      return respond(input, signal);
    },
  };
}

/** A well-formed answer choosing `pubkey`, citing its own first evidence. */
function validAnswer(input: AiRecommendationInput, pubkey: string, over: Record<string, unknown> = {}) {
  const c = input.candidates.find((x) => x.pubkey === pubkey)!;
  return {
    recommended_pubkey: pubkey,
    recommendation_reason: "Covers both the origin and destination of the corridor.",
    supporting_evidence_ids: c.evidence.slice(0, 3).map((e) => e.id),
    missing_information_ids: c.missing.slice(0, 1).map((e) => e.id),
    evidence_sufficient_to_distinguish: true,
    confidence: "medium",
    customer_explanation: "This agent publishes support for sending to Kenya via M-Pesa and also lists Uganda.",
    ...over,
  };
}

async function expectFallback(
  provider: RecommendationProvider,
  reason: FallbackReason,
  opts: { timeoutMs?: number } = {},
) {
  const seen: string[] = [];
  const r = await recommendAgent(UG_KE, AGENTS, {
    provider,
    timeoutMs: opts.timeoutMs,
    onFallback: (why, detail) => seen.push(`${why}: ${detail ?? ""}`),
  });
  assert.equal(r.source, "deterministic", seen.join());
  assert.equal(r.fallback_reason, reason, seen.join());
  assert.equal(r.recommended_pubkey, pk("a")); // deterministic #1
  assert.equal(r.recommendation_reason, FALLBACK_REASON_TEXT);
  return { r, seen };
}

// --- AI path ------------------------------------------------------------

test("AI recommends an eligible agent", async () => {
  const calls: Call[] = [];
  const r = await recommendAgent(UG_KE, AGENTS, {
    provider: mockProvider((input) => validAnswer(input, pk("c")), calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(r.source, "ai");
  assert.equal(r.fallback_reason, null);
  assert.equal(r.recommended_pubkey, pk("c")); // AI may pick any eligible agent, not only #1
  assert.equal(r.recommended_agent?.eligible, true);
  assert.equal(r.confidence, "medium");
  // Evidence is mapped from cited IDs back to the matcher's own text.
  assert.ok(r.supporting_evidence.includes("operates in KE"));
  assert.ok(r.supporting_evidence.every((e) => r.recommended_agent!.matched_capabilities.concat(
    r.recommended_agent!.score_breakdown.map((s) => s.detail)).includes(e)));
  assert.equal(r.match.eligible.length, 3); // deterministic result still attached
});

test("AI cannot recommend an ineligible agent", async () => {
  await expectFallback(mockProvider((input) => ({ ...validAnswer(input, pk("a")), recommended_pubkey: pk("d") })), "invalid_response");
});

test("AI response with an unknown pubkey is rejected", async () => {
  await expectFallback(mockProvider((input) => ({ ...validAnswer(input, pk("a")), recommended_pubkey: pk("f") })), "invalid_response");
});

test("fabricated capabilities are rejected", async (t) => {
  const cases: Record<string, (i: AiRecommendationInput) => unknown> = {
    "evidence ID that was never supplied": (i) =>
      validAnswer(i, pk("c"), { supporting_evidence_ids: ["A2.E99"] }),
    "another agent's evidence claimed for the recommended agent": (i) => {
      const a1 = i.candidates.find((c) => c.pubkey === pk("a"))!;
      return validAnswer(i, pk("c"), { supporting_evidence_ids: [a1.evidence[0].id] });
    },
    "free-form capability field not in the schema": (i) =>
      ({ ...validAnswer(i, pk("c")), capabilities: ["supports TZS payouts"] }),
    "invented exchange rate in prose": (i) =>
      validAnswer(i, pk("c"), { customer_explanation: "At 1 UGX = 0.035 KES the recipient gets 3500 KES." }),
    "invented currency in prose": (i) =>
      validAnswer(i, pk("c"), { recommendation_reason: "Also pays out in USD and TZS." }),
    "invented fee in prose": (i) =>
      validAnswer(i, pk("c"), { recommendation_reason: "Charges only a 2% fee." }),
    "invented availability in prose": (i) =>
      validAnswer(i, pk("c"), { customer_explanation: "This agent is online now and pays out instantly." }),
  };
  for (const [name, respond] of Object.entries(cases)) {
    await t.test(name, async () => {
      await expectFallback(mockProvider(respond), "invalid_response");
    });
  }
});

test("other agents' missing-info IDs are ignored, not fatal (seen from the real model)", async () => {
  // Real Claude output: recommends the perfect agent (no gaps of its own) and
  // cites the runners-up' gaps to explain the comparison.
  const r = await recommendAgent(UG_KE, AGENTS, {
    provider: mockProvider((input) => {
      const others = input.candidates.filter((c) => c.pubkey !== pk("a"));
      return validAnswer(input, pk("a"), {
        missing_information_ids: others.flatMap((c) => c.missing.slice(0, 1).map((m) => m.id)),
      });
    }),
  });
  assert.equal(r.source, "ai");
  assert.equal(r.recommended_pubkey, pk("a"));
  assert.deepEqual(r.missing_information, []); // none of those gaps describe agent a
});

test("prose citing supplied numbers and codes is accepted", async () => {
  const r = await recommendAgent(UG_KE, AGENTS, {
    provider: mockProvider((input) =>
      validAnswer(input, pk("a"), { recommendation_reason: "Accepts UGX and pays out KES; 100,000 UGX is within its published limits." })),
  });
  assert.equal(r.source, "ai");
});

test("confidence is capped at limited when evidence cannot distinguish agents", async () => {
  const saysSo = await recommendAgent(UG_KE, AGENTS, {
    provider: mockProvider((input) => validAnswer(input, pk("a"), { confidence: "high", evidence_sufficient_to_distinguish: false })),
  });
  assert.equal(saysSo.confidence, "limited");

  // Two identical agents -> deterministic scores tie -> cap applies even if the AI claims high.
  const twin = { ...PERFECT, pubkey: pk("e"), escrowReference: `30361:${pk("e")}:escrow` };
  const tied = await recommendAgent(UG_KE, [PERFECT, twin], {
    provider: mockProvider((input) => {
      assert.equal(input.ranking_is_tied, true);
      return validAnswer(input, pk("e"), { confidence: "high" });
    }),
  });
  assert.equal(tied.source, "ai");
  assert.equal(tied.confidence, "limited");
});

// --- Fallbacks ----------------------------------------------------------

test("malformed AI responses trigger the fallback", async (t) => {
  const cases: Record<string, (i: AiRecommendationInput) => unknown> = {
    "plain prose": () => "I recommend Agent a because they are great.",
    null: () => null,
    "missing required fields": (i) => ({ recommended_pubkey: i.candidates[0].pubkey }),
    "bad confidence value": (i) => validAnswer(i, pk("a"), { confidence: "certain" }),
    "empty evidence": (i) => validAnswer(i, pk("a"), { supporting_evidence_ids: [] }),
    "overlong explanation": (i) => validAnswer(i, pk("a"), { customer_explanation: "x".repeat(401) }),
  };
  for (const [name, respond] of Object.entries(cases)) {
    await t.test(name, async () => {
      await expectFallback(mockProvider(respond), "invalid_response");
    });
  }
});

test("provider failure triggers the fallback", async () => {
  const { seen } = await expectFallback(
    mockProvider(() => {
      throw new Error("503 overloaded");
    }),
    "provider_error",
  );
  assert.match(seen[0], /503 overloaded/);
});

test("timeout triggers the fallback and aborts the provider call", async () => {
  const calls: Call[] = [];
  await expectFallback(mockProvider(() => new Promise(() => {}), calls), "timeout", { timeoutMs: 20 });
  assert.equal(calls[0].signal.aborted, true);
});

test("missing credentials trigger the fallback", async () => {
  await expectFallback(
    mockProvider(() => {
      throw new MissingCredentialsError();
    }),
    "missing_credentials",
  );
});

test("config: no key means no AI; NEXT_PUBLIC keys are never read", () => {
  assert.deepEqual(readAiConfig({}), { ok: false, reason: "missing_credentials" });
  assert.deepEqual(readAiConfig({ ANTHROPIC_API_KEY: "   " }), { ok: false, reason: "missing_credentials" });
  assert.deepEqual(readAiConfig({ NEXT_PUBLIC_ANTHROPIC_API_KEY: "sk-test" }), { ok: false, reason: "missing_credentials" });
  assert.deepEqual(readAiConfig({ ANTHROPIC_API_KEY: "sk-test", PONTSWAP_AI_DISABLED: "1" }), { ok: false, reason: "disabled" });
  const ok = readAiConfig({ ANTHROPIC_API_KEY: "sk-test" });
  assert.ok(ok.ok && ok.config.model === DEFAULT_MODEL && ok.config.timeoutMs === 20_000);
});

test("deterministic result is available without AI", async () => {
  const r = await recommendAgent(UG_KE, AGENTS); // no provider at all
  assert.equal(r.source, "deterministic");
  assert.equal(r.fallback_reason, "no_provider");
  assert.equal(r.recommended_pubkey, pk("a"));
  assert.equal(r.recommendation_reason, FALLBACK_REASON_TEXT);
  assert.equal(r.confidence, "high"); // score 100, not tied
  assert.ok(r.supporting_evidence.includes("supports payment channel mpesa"));
  assert.ok(r.customer_explanation.length > 0);
});

test("no eligible agents: no recommendation, provider never called", async () => {
  const calls: Call[] = [];
  const r = await recommendAgent(UG_KE, [WRONG_COUNTRY], { provider: mockProvider(() => ({}), calls) });
  assert.equal(calls.length, 0);
  assert.equal(r.recommended_pubkey, null);
  assert.equal(r.fallback_reason, "no_eligible_agents");
  assert.equal(r.confidence, "limited");
});

test("empty discovery is reported as such, not as 'no agent supports this'", async () => {
  const calls: Call[] = [];
  const r = await recommendAgent(UG_KE, [], { provider: mockProvider(() => ({}), calls) });
  assert.equal(calls.length, 0);
  assert.equal(r.recommended_pubkey, null);
  assert.equal(r.fallback_reason, "no_agents_discovered");
  assert.doesNotMatch(r.customer_explanation, /publishes/);
});

// --- Privacy and safety -------------------------------------------------

test("AI input contains only eligible agents and no identities", async () => {
  const calls: Call[] = [];
  await recommendAgent(UG_KE, AGENTS, { provider: mockProvider((i) => validAnswer(i, pk("a")), calls), });
  const { input } = calls[0];
  assert.deepEqual(Object.keys(input).sort(), ["candidates", "ranking_is_tied", "request"]);
  assert.deepEqual(input.candidates.map((c) => c.pubkey).sort(), [pk("a"), pk("b"), pk("c")]);
  const json = JSON.stringify(input);
  assert.ok(!json.includes(pk("d")), "ineligible agent leaked to AI");
  assert.ok(!json.includes("30361:"), "escrow coordinates are not needed by the AI");
});

test("third-party strings are clipped before reaching the AI", () => {
  const long = agent("a", { ...(PERFECT.content as { capabilities: object }).capabilities });
  (long.content as { name: string }).name = "N".repeat(500);
  const r = buildAiInput(matchAgents(UG_KE, [long]));
  assert.ok(r.candidates[0].name!.length <= 80);
});

test("no AI result can mutate swap state", async () => {
  // 1. The provider gets plain data and an AbortSignal — no signer, relay, or swap handle.
  const calls: Call[] = [];
  const agentsBefore = structuredClone(AGENTS);
  const r = await recommendAgent(UG_KE, AGENTS, {
    provider: mockProvider((i) => ({ ...validAnswer(i, pk("a")), publish: true, state: "released" }), calls),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].input)), calls[0].input); // serialisable data only
  // 2. Extra action-like fields are rejected, not acted on.
  assert.equal(r.fallback_reason, "invalid_response");
  // 3. Inputs are untouched and the result is plain data.
  assert.deepEqual(AGENTS, agentsBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);

  // 4. Static guarantee: nothing in the recommendation path imports code that
  //    signs, publishes, or mutates swaps. server.ts may only read discovery.
  const dir = join(process.cwd(), "src/lib/recommendation");
  const forbidden = /pontmore\/(swap|relay|signer|gift-wrap)|appendTransition|publish|signEvent/;
  for (const f of ["recommend.ts", "types.ts", "prompt.ts", "config.ts", "providers/anthropic.ts", "server.ts"]) {
    const src = readFileSync(join(dir, f), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
    assert.doesNotMatch(imports, forbidden, `${f} imports a mutating module`);
  }
  const server = readFileSync(join(dir, "server.ts"), "utf8");
  assert.match(server, /from "@\/lib\/pontmore\/discovery"/);
});

// --- Existing flow ------------------------------------------------------

test("existing fiat_to_btc flow is unaffected", () => {
  // Transition matrix is byte-for-byte what it was.
  assert.deepEqual(FIAT_TO_BTC_TRANSITIONS, {
    requested: { agent: ["accepted", "canceled", "expired"], customer: ["canceled"] },
    accepted: { agent: ["funded", "canceled"], customer: ["canceled"] },
    funded: { customer: ["fiat_sent", "disputed"], agent: ["refunded", "disputed"] },
    fiat_sent: { agent: ["fiat_confirmed", "disputed"], customer: ["disputed"] },
    fiat_confirmed: { agent: ["released", "disputed"] },
    released: { customer: ["completed"], agent: ["completed"] },
    disputed: { escrow: ["released", "refunded"] },
    completed: {},
    expired: {},
    canceled: {},
    refunded: {},
  });
  const happy = replayTransitions([
    { to: "accepted", role: "agent" },
    { to: "funded", role: "agent" },
    { to: "fiat_sent", role: "customer" },
    { to: "fiat_confirmed", role: "agent" },
    { to: "released", role: "agent" },
    { to: "completed", role: "customer" },
  ]);
  assert.deepEqual(happy, { ok: true, state: "completed" });

  const p = pk("a");
  const legacy = SwapRequestContent.safeParse({
    version: 1,
    swap_id: "x",
    swap_type: "fiat_to_btc",
    agent: p,
    customer: p,
    escrow_reference: `30361:${p}:escrow`,
    fiat: { currency: "KES", amount: "5000", rail: "mpesa" },
    bitcoin: { amount_sats: "3200000", payout: "lightning" },
    expiry: 2_000_000_000,
  });
  assert.equal(legacy.success, true);
});
