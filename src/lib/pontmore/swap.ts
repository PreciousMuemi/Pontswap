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
import { publishEvent, queryEvents, subscribe } from "./relay";
import type { Signer } from "./signer";
import {
  KIND_SWAP_REQUEST,
  KIND_TRANSITION,
  SwapRequestContent,
  TransitionContent,
  parseContent,
  type FiatLeg,
  type BitcoinLeg,
  type SwapType,
} from "./kinds";
import { replayTransitions, type SwapState, type ActorRole } from "./states";

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

export type AppendTransitionParams = {
  swapId: string;
  state: SwapState;
  prevState: SwapState;
  actorRole: ActorRole;
  reason: string;
  requestEventId: string; // id of the originating 7300
};

/**
 * Build, validate, sign, and publish a kind 7301 state transition. Callers are
 * responsible for gating on canTransition() before invoking this — this only
 * enforces the content schema, not the matrix.
 */
export async function appendTransition(
  signer: Signer,
  params: AppendTransitionParams,
): Promise<Event> {
  const content = TransitionContent.parse({
    swap_id: params.swapId,
    state: params.state,
    prev_state: params.prevState,
    actor_role: params.actorRole,
    reason: params.reason,
    created_at: nowSeconds(),
  });

  const event = await signer.signEvent({
    kind: KIND_TRANSITION,
    created_at: nowSeconds(),
    tags: [
      ["e", params.requestEventId],
      ["swap_id", params.swapId],
      ["d", params.swapId], // indexable
    ],
    content: JSON.stringify(content),
  });

  await publishEvent(event);
  return event;
}

/**
 * Subscribe to incoming swap requests addressed to an agent. Delivers both
 * stored and live kind 7300 events tagged ["p", agentPubkey]. Returns an
 * unsubscribe function.
 */
export function subscribeAgentInbox(
  agentPubkey: string,
  onSwapRequest: (e: Event) => void,
): () => void {
  return subscribe(
    [{ kinds: [KIND_SWAP_REQUEST], "#p": [agentPubkey] }],
    onSwapRequest,
  );
}

/**
 * Subscribe to every event in a swap (request, transitions, evidence, notes,
 * snapshot), stored and live, via the indexable "d" tag. Returns unsubscribe.
 */
export function subscribeSwap(
  swapId: string,
  onEvent: (e: Event) => void,
): () => void {
  return subscribe([{ "#d": [swapId] }], onEvent);
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

/** Parse a 7301 event's content, or null if invalid. */
export function parseTransition(event: Event) {
  try {
    return parseContent(TransitionContent, event.content);
  } catch {
    return null;
  }
}

export type SwapStateView = {
  /** The originating 7300, or null if not present in the given events. */
  requestEvent: Event | null;
  /** Current derived state. "requested" once a 7300 exists. */
  state: SwapState;
  /** Validity of the replayed 7301 chain. */
  ok: boolean;
  /** Index of the first invalid 7301 (in chronological order), if any. */
  invalidIndex: number | null;
  /** Chronologically ordered, validated transition steps. */
  steps: { to: SwapState; role: ActorRole; event: Event }[];
};

/**
 * Derive current swap state by replaying the 7301 chain over a set of events.
 * State is ALWAYS computed this way — never stored. The 7300 establishes the
 * implicit "requested" base; each valid 7301 advances it.
 */
export function currentStateFromHistory(events: Event[]): SwapStateView {
  const requestEvent =
    events.find((e) => e.kind === KIND_SWAP_REQUEST) ?? null;

  const steps = events
    .filter((e) => e.kind === KIND_TRANSITION)
    .map((event) => {
      const c = parseTransition(event);
      return c ? { to: c.state, role: c.actor_role, event } : null;
    })
    .filter((s): s is { to: SwapState; role: ActorRole; event: Event } => !!s)
    .sort((a, b) => a.event.created_at - b.event.created_at);

  const replay = replayTransitions(
    steps.map((s) => ({ to: s.to, role: s.role })),
  );

  return {
    requestEvent,
    state: replay.state,
    ok: replay.ok,
    invalidIndex: replay.ok ? null : replay.invalidIndex,
    steps,
  };
}
