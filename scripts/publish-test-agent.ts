// scripts/publish-test-agent.ts
//
// Publish a DEMO agent (kind 30360) and its escrow descriptor (kind 30361) so
// the cross-border flow has an agent you control. Testing only: the agent is
// labelled as a demo and no real funds are involved.
//
//   npm run agent:publish                      # dry run: prints the events, publishes nothing
//   npm run agent:publish -- --publish         # publish to the default relays
//   npm run agent:publish -- --publish --secret <64-hex>   # re-publish/update the same agent
//   npm run agent:publish -- --relays ws://localhost:7777 --publish
//   npm run agent:publish -- --name "My Demo Agent"
//
// Without --secret a new keypair is generated and printed. Keep the hex secret:
// paste it into "Use a dev key instead" on /agent/inbox to act as this agent.
// Re-running with the same --secret updates the agent instead of creating
// another one. For a whole roster of demo agents, see publish-demo-agents.ts.

import { generateSecretKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { nsecEncode } from "nostr-tools/nip19";
import { hexToNpub } from "@/lib/pontmore/nip19";
import { DEFAULT_RELAYS } from "@/config/relays";
import { matchAgents } from "@/lib/matching/agent-matching";
import {
  buildDemoAgentEvents,
  bytesToHex,
  hexToBytes,
  publishToRelays,
  readBackAgents,
} from "./lib/demo-agent";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const publish = flag("publish");
  const relays = arg("relays")?.split(",").map((r) => r.trim()) ?? [...DEFAULT_RELAYS];
  const name = arg("name") ?? "PontSwap Demo Agent (UG→KE)";

  const secretArg = arg("secret");
  if (secretArg && !/^[0-9a-f]{64}$/i.test(secretArg)) {
    throw new Error("--secret must be a 64-character hex secret key");
  }
  const generated = !secretArg;
  const secretHex = secretArg?.toLowerCase() ?? bytesToHex(generateSecretKey());

  const { pubkey, escrowEvent, agentEvent } = await buildDemoAgentEvents(secretHex, {
    name,
    about: "DEMO agent for the PontSwap cross-border flow. Testing only — no real funds move.",
    capabilities: {
      swap_types: ["fiat_to_btc", "cross_border"],
      regions: ["UG", "KE"],
      fiat_currencies: ["UGX", "KES"],
      payment_channels: ["mtn-momo", "mpesa"],
      settlement_networks: ["lightning"],
      limits: { min: "50000 UGX", max: "5000000 UGX" },
    },
  });

  console.log(`agent name: ${name}`);
  console.log(`agent npub: ${hexToNpub(pubkey)}`);
  console.log(`relays:     ${relays.join(", ")}`);
  if (generated) {
    console.log("\nNew keypair generated. SAVE THIS — you need it to act as the agent or update it:");
    console.log(`  secret (hex, for "Use a dev key instead"): ${secretHex}`);
    console.log(`  nsec:                                      ${nsecEncode(hexToBytes(secretHex))}`);
  }

  if (!publish) {
    console.log("\nDRY RUN — nothing published. Events that would be sent:\n");
    console.log(JSON.stringify([escrowEvent, agentEvent], null, 2));
    console.log("\nRe-run with --publish to publish" + (generated ? " (add --secret <hex> to reuse this key)." : "."));
    return;
  }

  const pool = new SimplePool();
  try {
    for (const event of [escrowEvent, agentEvent]) {
      const { accepted, rejected } = await publishToRelays(pool, relays, event);
      console.log(`published kind ${event.kind}: accepted by ${accepted}/${relays.length} relays`);
      rejected.forEach((r) => console.log(`  rejected — ${r}`));
      if (!accepted) throw new Error(`no relay accepted kind ${event.kind}`);
    }

    // Read back and check the matcher sees an eligible agent.
    await new Promise((r) => setTimeout(r, 1500));
    const latest = (await readBackAgents(pool, relays, [pubkey])).get(pubkey);
    if (!latest) throw new Error("published agent not found when reading back from the relays");

    const content = JSON.parse(latest.content);
    const { eligible, ineligible } = matchAgents(
      {
        origin_country: "UG",
        destination_country: "KE",
        origin_currency: "UGX",
        destination_currency: "KES",
        amount: "100000",
        payout_method: "mpesa",
        settlement_asset: "BTC",
      },
      [{ pubkey, content, escrowReference: content.escrow?.descriptor ?? null }],
    );
    const m = eligible[0] ?? ineligible[0];
    console.log(`\nread back from relays: ok`);
    console.log(`UG → KE → M-Pesa match: ${m.eligible ? `eligible, score ${m.score}/100` : "NOT eligible"}`);
    if (!m.eligible) console.log(`  ${m.explanation}`);
    console.log(`\nNext: open /agent/inbox, choose "Use a dev key instead", paste the hex secret.`);
  } finally {
    pool.destroy();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nfailed:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
