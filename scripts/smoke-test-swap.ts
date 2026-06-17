// scripts/smoke-test-swap.ts
//
// Round-trip smoke test: publish a real kind 7300 swap request to the
// configured relays, then query it back by swap_id and assert it matches.
//
//   npx tsx scripts/smoke-test-swap.ts
//
// Uses an in-memory dev keypair (NEVER a real identity). No funds, no agent —
// the "agent" is a throwaway key so the request validates structurally.

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getDevSigner } from "@/lib/pontmore/signer";
import { publishSwapRequest, fetchSwapHistory } from "@/lib/pontmore/swap";
import { getPool, getRelays } from "@/lib/pontmore/relay";
import { coordinate, KIND_ESCROW_DESCRIPTOR } from "@/lib/pontmore/kinds";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const customerHex = bytesToHex(generateSecretKey());
  const signer = getDevSigner(customerHex);
  const customerPub = await signer.getPublicKey();

  const agentPub = getPublicKey(generateSecretKey());
  const escrowReference = coordinate(
    KIND_ESCROW_DESCRIPTOR,
    agentPub,
    "escrow",
  );

  console.log("relays:", getRelays().join(", "));
  console.log("customer:", customerPub.slice(0, 16), "…");
  console.log("agent:", agentPub.slice(0, 16), "…");

  const { event, swapId } = await publishSwapRequest(signer, {
    agentPubkey: agentPub,
    escrowReference,
    fiat: { currency: "KES", amount: "5000", rail: "mpesa" },
    bitcoin: { amount_sats: "3200000", payout: "lightning" },
  });

  console.log("\npublished 7300:", event.id.slice(0, 16), "…");
  console.log("swap_id:", swapId);

  // Give relays a moment to index before querying back.
  await new Promise((r) => setTimeout(r, 1500));

  const history = await fetchSwapHistory(swapId);
  const found = history.find((e) => e.id === event.id);

  if (!found) {
    console.error(
      `\n❌ FAIL: published 7300 not returned by fetchSwapHistory(${swapId}).`,
    );
    console.error(
      "   The relays may reject kind 7300. See PROMPT.md — try a local nostr-rs-relay.",
    );
    getPool().destroy();
    process.exit(1);
  }

  console.log(
    `\n✅ PASS: round-trip ok — fetched ${history.length} event(s), 7300 matched.`,
  );
  getPool().destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ smoke test threw:", err);
  process.exit(1);
});
