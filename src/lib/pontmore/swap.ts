// lib/pontmore/swap.ts
//
// Swap lifecycle publish/subscribe helpers. Every content payload is validated
// with the zod schemas in kinds.ts before it is signed — never raw JSON.parse
// on the way out, never trusting raw content on the way in.
//
// Tag conventions (see PROMPT.md):
//   - every swap event carries ["swap_id", <id>] (human-readable; mirrors the
//     value inside content)
//   - every swap event ALSO carries ["d", <swap_id>] — this is the tag relays
//     actually index. NIP-01 only supports single-letter tag filters, so a
//     multi-letter "#swap_id" filter returns nothing on standard relays
//     (verified empirically against nos.lol / relay.damus.io). "#d" works, and
//     since the 30362 snapshot already keys on ["d", swap_id], a single
//     {"#d":[swapId]} filter returns the entire chain including the snapshot.
//   - 7300 also carries ["p", <agent_pubkey>] for notification
//   - 7301 / 7302 also carry ["e", <request_event_id>] linking to the 7300
//
// Phase 4 implements publishSwapRequest + fetchSwapHistory. The remaining
// helpers from the spec land in their respective phases.

import type { Event } from "nostr-tools";
import { publishEvent, queryEvents } from "./relay";
import type { Signer } from "./signer";
import {
  KIND_SWAP_REQUEST,
  SwapRequestContent,
  parseContent,
  type FiatLeg,
  type BitcoinLeg,
  type SwapType,
} from "./kinds";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Default time-to-live for a swap request if the caller gives no expiry. */
const DEFAULT_EXPIRY_SECONDS = 60 * 60; // 1 hour

export type PublishSwapRequestParams = {
  agentPubkey: string; // hex
  escrowReference: string; // 30361 coordinate
  fiat: FiatLeg;
  bitcoin: BitcoinLeg;
  swapType?: SwapType; // defaults to fiat_to_btc (v1 scope)
  expiry?: number; // unix seconds; defaults to now + 1h
  swapId?: string; // override for deterministic tests
};

/**
 * Build, validate, sign, and publish a kind 7300 swap request. The customer is
 * the signing identity. Returns the signed event and the generated swap_id.
 */
export async function publishSwapRequest(
  signer: Signer,
  params: PublishSwapRequestParams,
): Promise<{ event: Event; swapId: string }> {
  const customer = await signer.getPublicKey();
  const swapId = params.swapId ?? crypto.randomUUID();

  const content = SwapRequestContent.parse({
    version: 1,
    swap_id: swapId,
    swap_type: params.swapType ?? "fiat_to_btc",
    agent: params.agentPubkey,
    customer,
    escrow_reference: params.escrowReference,
    fiat: params.fiat,
    bitcoin: params.bitcoin,
    expiry: params.expiry ?? nowSeconds() + DEFAULT_EXPIRY_SECONDS,
  });

  const event = await signer.signEvent({
    kind: KIND_SWAP_REQUEST,
    created_at: nowSeconds(),
    tags: [
      ["p", params.agentPubkey],
      ["swap_id", swapId],
      ["d", swapId], // indexable: relays filter on single-letter tags only
    ],
    content: JSON.stringify(content),
  });

  await publishEvent(event);
  return { event, swapId };
}

/**
 * Fetch every event tagged with this swap_id, oldest first. This is the raw
 * chain the swap room and explorer replay to derive current state.
 */
export async function fetchSwapHistory(swapId: string): Promise<Event[]> {
  // Filter on the indexable single-letter "d" tag, not "swap_id" — relays do
  // not index multi-letter tag filters. See the tag-conventions note above.
  const events = await queryEvents([{ "#d": [swapId] }]);
  return events.sort((a, b) => a.created_at - b.created_at);
}

/** Read the swap_id tag off an event, if present. */
export function swapIdOf(event: Event): string | null {
  return event.tags.find((t) => t[0] === "swap_id")?.[1] ?? null;
}

/** Parse a 7300 event's content, or null if it is not a valid swap request. */
export function parseSwapRequest(event: Event) {
  try {
    return parseContent(SwapRequestContent, event.content);
  } catch {
    return null;
  }
}
