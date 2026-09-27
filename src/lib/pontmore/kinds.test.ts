// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SwapRequestContent, SnapshotContent, satsLabel } from "./kinds";

const pk = "a".repeat(64);
const base = {
  version: 1,
  swap_id: "x",
  agent: pk,
  customer: pk,
  escrow_reference: `30361:${pk}:escrow`,
  expiry: 2_000_000_000,
};
const corridor = {
  origin_country: "UG",
  destination_country: "KE",
  destination_currency: "KES",
  payout_method: "mpesa",
  settlement_asset: "BTC",
};
const ugx = { currency: "UGX", amount: "100000", rail: "mtn-momo" };

test("cross_border request may omit amount_sats", () => {
  const r = SwapRequestContent.safeParse({
    ...base, swap_type: "cross_border", corridor, fiat: ugx, bitcoin: { payout: "lightning" },
  });
  assert.equal(r.success, true);
  assert.equal(r.success && satsLabel(r.data.bitcoin), "sats set at settlement");
});

test("cross_border request with amount_sats still validates it", () => {
  assert.equal(SwapRequestContent.safeParse({
    ...base, swap_type: "cross_border", corridor, fiat: ugx, bitcoin: { amount_sats: "25000", payout: "lightning" },
  }).success, true);
  assert.equal(SwapRequestContent.safeParse({
    ...base, swap_type: "cross_border", corridor, fiat: ugx, bitcoin: { amount_sats: "12.5", payout: "lightning" },
  }).success, false);
});

test("fiat_to_btc still requires amount_sats", () => {
  const kes = { currency: "KES", amount: "5000", rail: "mpesa" };
  assert.equal(SwapRequestContent.safeParse({
    ...base, swap_type: "fiat_to_btc", fiat: kes, bitcoin: { payout: "lightning" },
  }).success, false);
  const ok = SwapRequestContent.safeParse({
    ...base, swap_type: "fiat_to_btc", fiat: kes, bitcoin: { amount_sats: "3200000", payout: "lightning" },
  });
  assert.equal(ok.success, true);
  assert.equal(ok.success && satsLabel(ok.data.bitcoin), "3200000 sats");
});

test("snapshots follow the same rule", () => {
  const snap = (swap_type: string, bitcoin: object, extra: object = {}) =>
    SnapshotContent.safeParse({
      swap_id: "x", final_state: "completed", agent: pk, customer: pk, swap_type,
      fiat: ugx, bitcoin, transitions: [], completed_at: 2_000_000_000, ...extra,
    }).success;
  assert.equal(snap("cross_border", { payout: "lightning" }, { corridor }), true);
  assert.equal(snap("fiat_to_btc", { payout: "lightning" }), false);
});
