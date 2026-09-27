// scripts/publish-demo-agents.ts
//
// Publish a ROSTER of demo agents with deliberately different capabilities so
// the recommendation has real choices to make: some fit UG → KE → M-Pesa
// well, some weakly, some not at all (to show eligibility filtering), and two
// identical Tanzania agents to show the "limited confidence" tie case.
// Every agent is labelled as a demo; no real funds are involved.
//
//   npm run agents:publish                         # dry run: prints the roster, publishes nothing
//   npm run agents:publish -- --publish            # publish (generates and prints a seed)
//   npm run agents:publish -- --publish --seed <64-hex>   # update the same agents
//   npm run agents:publish -- --relays ws://localhost:7777 --publish
//   npm run agents:publish -- --publish --seed <hex> --delay-ms 4000   # slower, for strict relays
//
// Keys are derived from one seed (sha256 of seed + agent slug), so keeping the
// seed is enough to update every agent or log in as any of them. The seed can
// also come from the DEMO_AGENTS_SEED environment variable.

import { createHash, randomBytes } from "node:crypto";
import { SimplePool } from "nostr-tools/pool";
import { hexToNpub } from "@/lib/pontmore/nip19";
import { DEFAULT_RELAYS } from "@/config/relays";
import { matchAgents, type MatchRequest } from "@/lib/matching/agent-matching";
import {
  buildDemoAgentEvents,
  publishToRelays,
  readBackAgents,
  type DemoProfile,
} from "./lib/demo-agent";

const ABOUT = (what: string) =>
  `DEMO agent for the PontSwap cross-border flow — ${what}. Testing only; no real funds move.`;

/** Each profile is shaped to land at a specific point in the ranking. */
const ROSTER: Record<string, DemoProfile> = {
  "kampala-nairobi-express": {
    name: "Kampala–Nairobi Express (demo)",
    about: ABOUT("serves both ends of the corridor"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["UG", "KE"],
      fiat_currencies: ["UGX", "KES"],
      payment_channels: ["mtn-momo", "airtel-money", "mpesa"],
      settlement_networks: ["lightning"],
      limits: { min: "20000 UGX", max: "2000000 UGX" },
    },
  },
  "mombasa-payouts": {
    name: "Mombasa Payouts (demo)",
    about: ABOUT("Kenya payouts, declares cross-border"),
    capabilities: {
      swap_types: ["cross_border"],
      regions: ["KE"],
      fiat_currencies: ["KES"],
      payment_channels: ["mpesa"],
      settlement_networks: ["lightning", "bitcoin"],
      limits: { min: "1000 KES", max: "300000 KES" },
    },
  },
  "nairobi-mpesa-desk": {
    name: "Nairobi M-Pesa Desk (demo)",
    about: ABOUT("Kenya-only M-Pesa desk"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["KE"],
      fiat_currencies: ["KES", "USD"],
      payment_channels: ["mpesa", "bank-transfer"],
      settlement_networks: ["lightning"],
      limits: { min: "500 KES", max: "250000 KES" },
    },
  },
  "entebbe-high-value": {
    name: "Entebbe High-Value Desk (demo)",
    about: ABOUT("large transfers only"),
    capabilities: {
      swap_types: ["cross_border"],
      regions: ["UG", "KE"],
      fiat_currencies: ["UGX", "KES"],
      payment_channels: ["mtn-momo", "mpesa"],
      settlement_networks: ["lightning"],
      limits: { min: "500000 UGX", max: "50000000 UGX" },
    },
  },
  "nairobi-bank-desk": {
    name: "Nairobi Bank Desk (demo)",
    about: ABOUT("bank transfers only"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["KE"],
      fiat_currencies: ["KES"],
      payment_channels: ["bank-transfer"],
      settlement_networks: ["lightning"],
    },
  },
  "kenya-onchain-desk": {
    name: "Kenya Onchain Desk (demo)",
    about: ABOUT("on-chain BTC settlement only"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["KE"],
      fiat_currencies: ["KES"],
      payment_channels: ["mpesa"],
      settlement_networks: ["bitcoin"],
    },
  },
  "lagos-naira-desk": {
    name: "Lagos Naira Desk (demo)",
    about: ABOUT("Nigeria only"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["NG"],
      fiat_currencies: ["NGN"],
      payment_channels: ["bank-transfer"],
      settlement_networks: ["lightning"],
    },
  },
  // Identical pair: a UG → TZ request ties them, showing "Limited confidence".
  "dar-mobile-money": {
    name: "Dar es Salaam Mobile Money (demo)",
    about: ABOUT("Tanzania payouts"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["TZ"],
      fiat_currencies: ["TZS"],
      payment_channels: ["mpesa", "tigo-pesa"],
      settlement_networks: ["lightning"],
      limits: { min: "5000 TZS", max: "5000000 TZS" },
    },
  },
  "arusha-mobile-money": {
    name: "Arusha Mobile Money (demo)",
    about: ABOUT("Tanzania payouts"),
    capabilities: {
      swap_types: ["fiat_to_btc"],
      regions: ["TZ"],
      fiat_currencies: ["TZS"],
      payment_channels: ["mpesa", "tigo-pesa"],
      settlement_networks: ["lightning"],
      limits: { min: "5000 TZS", max: "5000000 TZS" },
    },
  },
};

/** The requests the UI sends for the two demo corridors. */
const REQUESTS: Record<string, MatchRequest> = {
  "UG → KE (M-Pesa)": {
    origin_country: "UG", destination_country: "KE", origin_currency: "UGX", destination_currency: "KES",
    amount: "100000", payout_method: "mpesa", settlement_asset: "BTC", settlement_network: "lightning",
  },
  "UG → TZ (M-Pesa)": {
    origin_country: "UG", destination_country: "TZ", origin_currency: "UGX", destination_currency: "TZS",
    amount: "100000", payout_method: "mpesa", settlement_asset: "BTC", settlement_network: "lightning",
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const deriveSecret = (seed: string, slug: string) =>
  createHash("sha256").update(`pontswap-demo-agent:${seed}:${slug}`).digest("hex");

async function main() {
  const publish = flag("publish");
  const relays = arg("relays")?.split(",").map((r) => r.trim()) ?? [...DEFAULT_RELAYS];

  const seedArg = arg("seed") ?? process.env.DEMO_AGENTS_SEED;
  if (seedArg && !/^[0-9a-f]{64}$/i.test(seedArg)) throw new Error("--seed must be 64 hex characters");
  const generated = !seedArg;
  const seed = seedArg?.toLowerCase() ?? randomBytes(32).toString("hex");

  const now = Math.floor(Date.now() / 1000);
  const built = await Promise.all(
    Object.entries(ROSTER).map(async ([slug, profile]) => {
      const secret = deriveSecret(seed, slug);
      return { slug, profile, secret, ...(await buildDemoAgentEvents(secret, profile, now)) };
    }),
  );

  console.log(`relays: ${relays.join(", ")}`);
  if (generated) {
    console.log(`\nNew seed generated. SAVE THIS to update these agents later:\n  seed: ${seed}`);
  }
  console.log("\nRoster (hex secret = paste into \"Use a dev key instead\" to act as that agent):");
  for (const b of built) {
    console.log(`  ${b.profile.name.padEnd(36)} ${hexToNpub(b.pubkey)}\n  ${"".padEnd(36)} secret ${b.secret}`);
  }

  // Preview the ranking from the events we are about to publish.
  const preview = built.map((b) => ({
    pubkey: b.pubkey,
    content: JSON.parse(b.agentEvent.content),
    escrowReference: JSON.parse(b.agentEvent.content).escrow.descriptor,
  }));
  printRanking(preview, built);

  if (!publish) {
    console.log("\nDRY RUN — nothing published. Re-run with --publish" + (generated ? " --seed <seed above>." : "."));
    return;
  }

  const pool = new SimplePool();
  try {
    // Public relays rate-limit bursts (relay.damus.io bans after repeated
    // violations), so space the events out.
    const delayMs = Number(arg("delay-ms") ?? 2500);
    console.log("");
    for (const b of built) {
      const results = [];
      for (const event of [b.escrowEvent, b.agentEvent]) {
        results.push(await publishToRelays(pool, relays, event));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const ok = Math.min(...results.map((r) => r.accepted));
      console.log(`published ${b.profile.name}: ${ok}/${relays.length} relays`);
      results.flatMap((r) => r.rejected).forEach((r) => console.log(`  rejected — ${r}`));
    }

    await new Promise((r) => setTimeout(r, 2000));
    const found = await readBackAgents(pool, relays, built.map((b) => b.pubkey));
    console.log(`\nread back from relays: ${found.size}/${built.length} agents`);
    const missing = built.filter((b) => !found.has(b.pubkey)).map((b) => b.profile.name);
    if (missing.length) console.log(`  not yet visible: ${missing.join(", ")}`);
  } finally {
    pool.destroy();
  }
}

function printRanking(
  agents: { pubkey: string; content: unknown; escrowReference: string }[],
  built: { pubkey: string; profile: DemoProfile }[],
) {
  const nameOf = (pk: string) => built.find((b) => b.pubkey === pk)?.profile.name ?? pk.slice(0, 8);
  for (const [label, request] of Object.entries(REQUESTS)) {
    const { eligible, ineligible } = matchAgents(request, agents);
    console.log(`\nMatcher preview — ${label} (roster only; existing agents not included):`);
    for (const m of eligible) console.log(`  #${m.rank}  score ${String(m.score).padStart(3)}  ${nameOf(m.pubkey)}`);
    if (request.destination_country !== "KE") {
      console.log(`  (${ineligible.length} others ineligible for this corridor)`);
      continue;
    }
    for (const m of ineligible) {
      const why = m.unmet_requirements[0] ?? m.missing_information[0] ?? "requirements not met";
      console.log(`  —   ineligible  ${nameOf(m.pubkey)}: ${why}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nfailed:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
