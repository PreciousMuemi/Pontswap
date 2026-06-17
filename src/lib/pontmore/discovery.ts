// lib/pontmore/discovery.ts
//
// Read-only discovery of agents (kind 30360) and escrow descriptors
// (kind 30361). This app never publishes these — users who want to register an
// agent use the reference POC at https://poc.pontmore.xyz.
//
// The network carries malformed and unrelated data on these kinds (kind 30361
// is shared with an unrelated NIP-29 group app). Every event is validated with
// the lenient zod schemas in kinds.ts via safeParse; anything that fails is
// skipped, never thrown.

import type { Event } from "nostr-tools";
import { queryEvents } from "./relay";
import {
  KIND_AGENT_DEFINITION,
  KIND_ESCROW_DESCRIPTOR,
  AgentDefinitionContent,
  EscrowDescriptorContent,
} from "./kinds";

/** A validated 30360, paired with the publishing pubkey from the envelope. */
export type AgentDefinition = {
  pubkey: string; // hex; the agent's identity
  eventId: string;
  dTag: string;
  createdAt: number;
  /** 30361 coordinate this agent points at, if any. */
  escrowReference: string | null;
  content: AgentDefinitionContent;
};

/** A validated 30361, paired with its addressable coordinate. */
export type EscrowDescriptor = {
  pubkey: string;
  coordinate: string;
  content: EscrowDescriptorContent;
};

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function toAgentDefinition(event: Event): AgentDefinition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  const result = AgentDefinitionContent.safeParse(parsed);
  if (!result.success) return null;

  const escrowFromContent = result.data.escrow?.descriptor;
  const escrowFromTag = tagValue(event, "a"); // ["a", "30361:...:escrow"]
  return {
    pubkey: event.pubkey,
    eventId: event.id,
    dTag: tagValue(event, "d") ?? "",
    createdAt: event.created_at,
    escrowReference: escrowFromContent ?? escrowFromTag ?? null,
    content: result.data,
  };
}

/**
 * Newest-first list of validated agents. When the same pubkey has published
 * multiple 30360s, the most recent wins (replaceable-event semantics).
 */
export async function fetchAgents(opts?: {
  limit?: number;
}): Promise<AgentDefinition[]> {
  const events = await queryEvents([
    { kinds: [KIND_AGENT_DEFINITION], limit: opts?.limit ?? 100 },
  ]);

  const latestByPubkey = new Map<string, AgentDefinition>();
  for (const event of events) {
    const agent = toAgentDefinition(event);
    if (!agent) continue;
    const existing = latestByPubkey.get(agent.pubkey);
    if (!existing || agent.createdAt > existing.createdAt) {
      latestByPubkey.set(agent.pubkey, agent);
    }
  }

  return [...latestByPubkey.values()].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

/** Most recent validated agent definition for a single pubkey, or null. */
export async function fetchAgent(
  pubkeyHex: string,
): Promise<AgentDefinition | null> {
  const events = await queryEvents([
    { kinds: [KIND_AGENT_DEFINITION], authors: [pubkeyHex], limit: 10 },
  ]);
  let best: AgentDefinition | null = null;
  for (const event of events) {
    const agent = toAgentDefinition(event);
    if (!agent) continue;
    if (!best || agent.createdAt > best.createdAt) best = agent;
  }
  return best;
}

/** Parse a `kind:pubkey:d-tag` coordinate. Returns null if malformed. */
function parseCoordinate(
  coordinate: string,
): { kind: number; pubkey: string; dTag: string } | null {
  const idx1 = coordinate.indexOf(":");
  const idx2 = coordinate.indexOf(":", idx1 + 1);
  if (idx1 < 0 || idx2 < 0) return null;
  const kind = Number(coordinate.slice(0, idx1));
  const pubkey = coordinate.slice(idx1 + 1, idx2);
  const dTag = coordinate.slice(idx2 + 1);
  if (!Number.isInteger(kind) || !/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  return { kind, pubkey, dTag };
}

/**
 * Fetch a single escrow descriptor by its 30361 coordinate. Returns null if the
 * coordinate is malformed, the event is absent, or the content fails validation
 * (e.g. unrelated NIP-29 group state sharing kind 30361).
 */
export async function fetchEscrowDescriptor(
  coordinate: string,
): Promise<EscrowDescriptor | null> {
  const parts = parseCoordinate(coordinate);
  if (!parts) return null;

  const events = await queryEvents([
    {
      kinds: [KIND_ESCROW_DESCRIPTOR],
      authors: [parts.pubkey],
      "#d": [parts.dTag],
      limit: 5,
    },
  ]);

  // Newest valid one wins.
  const valid = events
    .sort((a, b) => b.created_at - a.created_at)
    .map((event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.content);
      } catch {
        return null;
      }
      const result = EscrowDescriptorContent.safeParse(parsed);
      if (!result.success) return null;
      return {
        pubkey: event.pubkey,
        coordinate,
        content: result.data,
      } satisfies EscrowDescriptor;
    })
    .find((d): d is EscrowDescriptor => d !== null);

  return valid ?? null;
}
