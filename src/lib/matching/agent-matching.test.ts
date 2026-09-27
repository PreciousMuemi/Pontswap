// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchAgents,
  evaluateAgent,
  parseLimit,
  type AgentCandidate,
  type MatchRequest,
} from "./agent-matching";

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
const ESCROW = (p: string) => `30361:${p}:escrow`;

/** Build an agent; `caps` replaces capabilities wholesale. */
function agent(
  id: string,
  caps: Record<string, unknown>,
  extra: Partial<AgentCandidate> = {},
): AgentCandidate {
  const pubkey = pk(id);
  return {
    pubkey,
    escrowReference: ESCROW(pubkey),
    createdAt: 1_700_000_000,
    content: { name: `Agent ${id}`, capabilities: caps },
    ...extra,
  };
}

const PERFECT_CAPS = {
  swap_types: ["cross_border"],
  regions: ["UG", "KE"],
  fiat_currencies: ["UGX", "KES"],
  payment_channels: ["mpesa"],
  settlement_networks: ["lightning", "bitcoin"],
  limits: { min: "50000 UGX", max: "5000000 UGX" },
};

const check = (m: ReturnType<typeof evaluateAgent>, r: string) =>
  m.checks.find((c) => c.requirement === r);

test("perfect UG → KE + KES + M-Pesa match", () => {
  const { eligible, ineligible } = matchAgents(UG_KE, [agent("a", PERFECT_CAPS)]);
  assert.equal(ineligible.length, 0);
  assert.equal(eligible.length, 1);
  const m = eligible[0];
  assert.equal(m.eligible, true);
  assert.equal(m.rank, 1);
  assert.equal(m.score, 100);
  assert.deepEqual(m.unmet_requirements, []);
  assert.deepEqual(m.missing_information, []);
  assert.ok(m.matched_capabilities.includes("operates in KE"));
  assert.ok(m.matched_capabilities.includes("supports fiat currency KES"));
  assert.ok(m.matched_capabilities.includes("supports payment channel mpesa"));
  assert.match(m.explanation, /is eligible/);
});

test("payout method matches across spellings (M-Pesa vs mpesa)", () => {
  const m = evaluateAgent(agent("a", PERFECT_CAPS), { ...UG_KE, payout_method: "M-Pesa" });
  assert.equal(check(m, "payout_method")?.status, "met");
});

test("wrong destination country is ineligible", () => {
  const m = evaluateAgent(agent("a", { ...PERFECT_CAPS, regions: ["NG", "GH"] }), UG_KE);
  assert.equal(m.eligible, false);
  assert.equal(check(m, "destination_country")?.status, "unmet");
  assert.match(m.unmet_requirements.join(), /not KE/);
  assert.equal(m.score, 0);
  assert.equal(m.rank, null);
});

test("country names are normalised; non-country regions are not expanded", () => {
  const named = evaluateAgent(agent("a", { ...PERFECT_CAPS, regions: ["Kenya"] }), UG_KE);
  assert.equal(check(named, "destination_country")?.status, "met");

  const europe = evaluateAgent(agent("b", { ...PERFECT_CAPS, regions: ["Europe"] }), UG_KE);
  assert.equal(europe.eligible, false);
  assert.equal(check(europe, "destination_country")?.status, "missing");
});

test("unsupported payout method is ineligible", () => {
  const m = evaluateAgent(
    agent("a", { ...PERFECT_CAPS, payment_channels: ["bank-transfer", "card"] }),
    UG_KE,
  );
  assert.equal(m.eligible, false);
  assert.equal(check(m, "payout_method")?.status, "unmet");
  assert.match(m.explanation, /do not include mpesa/);
});

test("unsupported destination currency is ineligible", () => {
  const m = evaluateAgent(agent("a", { ...PERFECT_CAPS, fiat_currencies: ["USD", "EUR"] }), UG_KE);
  assert.equal(m.eligible, false);
  assert.equal(check(m, "destination_currency")?.status, "unmet");
});

test("amount below minimum is ineligible", () => {
  const m = evaluateAgent(
    agent("a", { ...PERFECT_CAPS, limits: { min: "200000 UGX", max: "5000000 UGX" } }),
    UG_KE,
  );
  assert.equal(m.eligible, false);
  assert.equal(check(m, "amount_limits")?.status, "unmet");
  assert.match(m.unmet_requirements.join(), /100000 UGX is below minimum 200000 UGX/);
});

test("amount above maximum is ineligible", () => {
  const m = evaluateAgent(agent("a", { ...PERFECT_CAPS, limits: { max: "50000 UGX" } }), UG_KE);
  assert.equal(m.eligible, false);
  assert.match(m.unmet_requirements.join(), /above maximum 50000 UGX/);
});

test("destination limits are checked only when a quoted destination amount exists", () => {
  const caps = { ...PERFECT_CAPS, limits: { min: "1000 KES", max: "5000 KES" } };
  // No quote: KES limits vs UGX amount cannot be compared — never converted.
  const unquoted = evaluateAgent(agent("a", caps), UG_KE);
  assert.equal(unquoted.eligible, true);
  assert.equal(check(unquoted, "amount_limits")?.status, "missing");
  assert.match(unquoted.missing_information.join(), /no quote converts it/);
  assert.equal(unquoted.score, 80); // loses only the amount_within_limits points

  const quoted = evaluateAgent(agent("a", caps), { ...UG_KE, destination_amount: "9000" });
  assert.equal(quoted.eligible, false);
  assert.match(quoted.unmet_requirements.join(), /9000 KES is above maximum 5000 KES/);
});

test("missing capability metadata is reported, never assumed", () => {
  const m = evaluateAgent(agent("a", {}), UG_KE);
  assert.equal(m.eligible, false);
  assert.deepEqual(m.unmet_requirements, []); // nothing contradicted...
  for (const r of ["destination_country", "destination_currency", "payout_method", "settlement", "amount_limits"]) {
    assert.equal(check(m, r)?.status, "missing", r); // ...everything simply undeclared
  }
  assert.ok(m.missing_information.length >= 5);
  assert.match(m.explanation, /not declared/);
});

test("no escrow descriptor is ineligible", () => {
  const m = evaluateAgent(agent("a", PERFECT_CAPS, { escrowReference: null }), UG_KE);
  assert.equal(m.eligible, false);
  assert.equal(check(m, "escrow")?.status, "unmet");
});

test("multiple eligible agents are ranked deterministically", () => {
  const kenyaOnly = agent("b", {
    swap_types: ["fiat-to-btc", "btc-to-fiat"],
    regions: ["KE"],
    fiat_currencies: ["KES", "USD"],
    payment_channels: ["mpesa", "bank-transfer"],
    settlement_networks: ["bitcoin", "lightning"],
    limits: { min: "1000 KES", max: "500000 KES" },
  });
  const eastAfrica = agent("c", {
    swap_types: ["fiat-to-btc"],
    regions: ["Kenya", "Uganda"],
    fiat_currencies: ["KES", "UGX"],
    payment_channels: ["M-Pesa"],
    settlement_networks: ["lightning"],
  });
  const perfect = agent("a", PERFECT_CAPS);
  const wrongCountry = agent("d", { ...PERFECT_CAPS, regions: ["NG"] });

  const run = () => matchAgents(UG_KE, [kenyaOnly, wrongCountry, eastAfrica, perfect]);
  const { eligible, ineligible } = run();

  assert.deepEqual(eligible.map((m) => m.pubkey), [pk("a"), pk("c"), pk("b")]);
  assert.deepEqual(eligible.map((m) => m.rank), [1, 2, 3]);
  assert.deepEqual(eligible.map((m) => m.score), [100, 50, 0]);
  assert.deepEqual(ineligible.map((m) => m.pubkey), [pk("d")]);
  assert.deepEqual(run(), run()); // same input, same output
});

test("ties break on fewer missing items, then fresher metadata", () => {
  const older = agent("a", { ...PERFECT_CAPS, swap_types: [] }, { createdAt: 100 });
  const newer = agent("b", { ...PERFECT_CAPS, swap_types: [] }, { createdAt: 200 });
  const { eligible } = matchAgents(UG_KE, [older, newer]);
  assert.deepEqual(eligible.map((m) => m.pubkey), [pk("b"), pk("a")]);
});

test("malformed agent metadata is rejected per agent without throwing", () => {
  const malformed: AgentCandidate[] = [
    { pubkey: pk("1"), content: "not an object" },
    { pubkey: pk("2"), content: null },
    { pubkey: pk("3"), content: { name: "No caps" } }, // capabilities required
    { pubkey: pk("4"), content: { name: "Bad", capabilities: { fiat_currencies: [1, 2] } } },
    { pubkey: "not-hex", content: { name: "Bad key", capabilities: PERFECT_CAPS } },
  ];
  const { eligible, ineligible } = matchAgents(UG_KE, [...malformed, agent("a", PERFECT_CAPS)]);
  assert.deepEqual(eligible.map((m) => m.pubkey), [pk("a")]);
  assert.equal(ineligible.length, malformed.length);
  for (const m of ineligible) {
    assert.equal(m.eligible, false);
    assert.equal(m.checks[0].requirement, "metadata");
    assert.equal(m.checks[0].status, "unmet");
    assert.equal(m.unmet_requirements.length, 1);
  }
});

test("unreadable or unitless limits are unknown, not guessed", () => {
  const junk = evaluateAgent(agent("a", { ...PERFECT_CAPS, limits: { min: "lots", max: 500 } }), UG_KE);
  assert.equal(junk.eligible, true);
  assert.equal(check(junk, "amount_limits")?.status, "missing");
  assert.match(check(junk, "amount_limits")!.detail, /not a readable amount.*has no currency/);
});

test("parseLimit handles real network formats", () => {
  assert.deepEqual(parseLimit("1000 KES"), { amount: 1000, currency: "KES" });
  assert.deepEqual(parseLimit("KES 1,000"), { amount: 1000, currency: "KES" });
  assert.deepEqual(parseLimit("500"), { amount: 500, currency: null });
  assert.deepEqual(parseLimit(500), { amount: 500, currency: null });
  assert.equal(parseLimit("lots"), null);
  assert.equal(parseLimit(-1), null);
});

test("invalid request throws; agent inputs are not mutated", () => {
  assert.throws(() => matchAgents({ ...UG_KE, destination_country: "Kenya" }, []));
  const input = [agent("a", PERFECT_CAPS)];
  const snapshot = structuredClone(input);
  matchAgents(UG_KE, input);
  assert.deepEqual(input, snapshot);
});
