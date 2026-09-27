// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAgents, type AgentCandidate, type MatchRequest } from "@/lib/matching/agent-matching";
import { recommendAgent } from "./recommend";
import { toDiscoveryView, toRecommendationView, verifiedLabels } from "./view";
import type { RecommendationProvider } from "./types";

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
const agent = (id: string, caps: object): AgentCandidate => ({
  pubkey: pk(id),
  escrowReference: `30361:${pk(id)}:escrow`,
  content: { name: `Agent ${id}`, capabilities: caps },
});
const KENYA = agent("b", {
  regions: ["KE"], fiat_currencies: ["KES"], payment_channels: ["mpesa"], settlement_networks: ["lightning"],
});
const BOTH = agent("c", {
  regions: ["KE", "UG"], fiat_currencies: ["KES", "UGX"], payment_channels: ["M-Pesa"], settlement_networks: ["lightning"],
});
const NIGERIA = agent("d", {
  regions: ["NG"], fiat_currencies: ["KES"], payment_channels: ["mpesa"], settlement_networks: ["lightning"],
});

test("chips come only from verified checks and scored signals", () => {
  const { eligible } = matchAgents(UG_KE, [KENYA, BOTH]);
  const byPk = new Map(eligible.map((m) => [m.pubkey, m]));
  assert.deepEqual(verifiedLabels(byPk.get(pk("b"))!, UG_KE), ["Kenya", "KES", "M-Pesa", "BTC settlement", "Escrow linked"]);
  assert.deepEqual(verifiedLabels(byPk.get(pk("c"))!, UG_KE), [
    "Kenya", "KES", "M-Pesa", "BTC settlement", "Escrow linked", "Also in Uganda", "Accepts UGX",
  ]);
});

test("an agent without escrow never gets an 'Escrow linked' chip", () => {
  const noEscrow = { ...KENYA, escrowReference: null };
  const m = matchAgents(UG_KE, [noEscrow]).ineligible[0];
  assert.ok(!verifiedLabels(m, UG_KE).includes("Escrow linked"));
});

test("discovery view distinguishes no agents, none eligible, and eligible", () => {
  assert.deepEqual(toDiscoveryView(0, matchAgents(UG_KE, [])), { status: "no_agents_discovered" });
  assert.deepEqual(toDiscoveryView(1, matchAgents(UG_KE, [NIGERIA])), { status: "no_eligible_agents", agentsFound: 1 });
  const v = toDiscoveryView(3, matchAgents(UG_KE, [KENYA, BOTH, NIGERIA]));
  assert.equal(v.status, "eligible");
  assert.deepEqual(v.status === "eligible" && v.eligible.map((e) => e.pubkey), [pk("c"), pk("b")]);
});

test("browser view carries no escrow coordinates or ineligible agents", async () => {
  const provider: RecommendationProvider = {
    name: "mock",
    recommend: async (input) => ({
      recommended_pubkey: pk("c"),
      recommendation_reason: "Covers Uganda and Kenya.",
      supporting_evidence_ids: [input.candidates[0].evidence[0].id],
      missing_information_ids: [],
      evidence_sufficient_to_distinguish: true,
      confidence: "medium",
      customer_explanation: "This agent lists both Uganda and Kenya.",
    }),
  };
  const view = toRecommendationView(await recommendAgent(UG_KE, [KENYA, BOTH, NIGERIA], { provider }));
  const json = JSON.stringify(view);
  assert.equal(view.source, "ai");
  assert.equal(view.recommended?.pubkey, pk("c"));
  assert.deepEqual(view.alternatives.map((a) => a.pubkey), [pk("b")]); // recommended excluded
  assert.ok(!json.includes("30361:"), "escrow coordinate leaked to browser view");
  assert.ok(!json.includes(pk("d")), "ineligible agent leaked to browser view");
  assert.ok(!("match" in view), "raw match result must not be sent");
});

test("fallback view keeps the deterministic pick and reason", async () => {
  const view = toRecommendationView(await recommendAgent(UG_KE, [KENYA, BOTH]));
  assert.equal(view.source, "deterministic");
  assert.equal(view.fallbackReason, "no_provider");
  assert.equal(view.recommended?.pubkey, pk("c"));
  assert.equal(view.eligibleCount, 2);
});
