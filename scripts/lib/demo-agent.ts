// scripts/lib/demo-agent.ts
//
// Shared helpers for the demo-agent publishing scripts. Builds a kind 30360
// agent definition plus its linked kind 30361 escrow descriptor, validated
// with the same schemas discovery uses, and publishes/reads them back.
//
// Both events are replaceable (pubkey + d-tag), so publishing again with the
// same key updates the agent instead of creating a duplicate.

import { getPublicKey } from "nostr-tools/pure";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools";
import { getDevSigner } from "@/lib/pontmore/signer";
import {
  AgentDefinitionContent,
  EscrowDescriptorContent,
  KIND_AGENT_DEFINITION,
  KIND_ESCROW_DESCRIPTOR,
  coordinate,
} from "@/lib/pontmore/kinds";

export const AGENT_D_TAG = "pontswap-demo-agent";
export const ESCROW_D_TAG = "pontswap-demo-escrow";

export type DemoProfile = {
  name: string;
  about: string;
  capabilities: Record<string, unknown>;
  pricing_policy?: string;
};

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}
const pubkeyOf = (secretHex: string) => getPublicKey(hexToBytes(secretHex));

/** Sign the escrow descriptor and agent definition for one demo agent. */
export async function buildDemoAgentEvents(
  secretHex: string,
  profile: DemoProfile,
  now = Math.floor(Date.now() / 1000),
): Promise<{ pubkey: string; escrowEvent: Event; agentEvent: Event }> {
  const pubkey = pubkeyOf(secretHex);
  const signer = getDevSigner(secretHex);
  const escrowCoord = coordinate(KIND_ESCROW_DESCRIPTOR, pubkey, ESCROW_D_TAG);

  const escrowContent = EscrowDescriptorContent.parse({
    version: 1,
    escrow_type: "demo-honor-system",
    networks: ["lightning"],
    release_rules: { note: "Demo only. Honor-system release; no custody, no real funds." },
  });
  const agentContent = AgentDefinitionContent.parse({
    version: 1,
    name: profile.name,
    about: profile.about,
    capabilities: profile.capabilities,
    pricing_policy: profile.pricing_policy ?? "Demo only — no real pricing.",
    escrow: { descriptor: escrowCoord, notes: "Demo escrow descriptor; no custody." },
    updated_at: now,
  });

  const escrowEvent = await signer.signEvent({
    kind: KIND_ESCROW_DESCRIPTOR,
    created_at: now,
    tags: [["d", ESCROW_D_TAG]],
    content: JSON.stringify(escrowContent),
  });
  const agentEvent = await signer.signEvent({
    kind: KIND_AGENT_DEFINITION,
    created_at: now,
    tags: [["d", AGENT_D_TAG], ["a", escrowCoord]],
    content: JSON.stringify(agentContent),
  });
  return { pubkey, escrowEvent, agentEvent };
}

/** Publish one event; returns how many relays accepted it. */
export async function publishToRelays(
  pool: SimplePool,
  relays: string[],
  event: Event,
): Promise<{ accepted: number; rejected: string[] }> {
  const results = await Promise.allSettled(pool.publish(relays, event));
  return {
    accepted: results.filter((r) => r.status === "fulfilled").length,
    rejected: results.flatMap((r, i) => (r.status === "rejected" ? [`${relays[i]}: ${String(r.reason)}`] : [])),
  };
}

/** Latest published agent definition for these pubkeys, keyed by pubkey. */
export async function readBackAgents(
  pool: SimplePool,
  relays: string[],
  pubkeys: string[],
): Promise<Map<string, Event>> {
  const found: Event[] = await pool.querySync(relays, {
    kinds: [KIND_AGENT_DEFINITION],
    authors: pubkeys,
    "#d": [AGENT_D_TAG],
  });
  const latest = new Map<string, Event>();
  for (const e of found) {
    const prev = latest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) latest.set(e.pubkey, e);
  }
  return latest;
}
