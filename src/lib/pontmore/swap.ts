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
  KIND_EVIDENCE,
  KIND_SNAPSHOT,
  SwapRequestContent,
  TransitionContent,
  EvidenceContent,
  SnapshotContent,
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

export type PostEvidenceParams = {
  swapId: string;
  type: string; // fiat_transfer_reference, payout_proof, ...
  ref?: string; // public opaque reference (e.g. M-Pesa code)
  refHash?: string; // sha256 of a private artifact, hex
  note?: string;
  requestEventId: string; // 7300 id, for the ["e"] link
};

/**
 * Publish a kind 7302 evidence event. The schema requires at least one of
 * `ref` / `refHash`. Sensitive artifacts (screenshots) should be hashed and the
 * hash sent privately via gift wrap — never put the artifact in this public
 * event.
 */
export async function postEvidence(
  signer: Signer,
  params: PostEvidenceParams,
): Promise<Event> {
  const content = EvidenceContent.parse({
    swap_id: params.swapId,
    type: params.type,
    ...(params.ref ? { ref: params.ref } : {}),
    ...(params.refHash ? { ref_hash: params.refHash } : {}),
    ...(params.note ? { note: params.note } : {}),
  });

  const event = await signer.signEvent({
    kind: KIND_EVIDENCE,
    created_at: nowSeconds(),
    tags: [
      ["e", params.requestEventId],
      ["swap_id", params.swapId],
      ["d", params.swapId],
    ],
    content: JSON.stringify(content),
  });

  await publishEvent(event);
  return event;
}

/**
 * Publish a kind 30362 swap snapshot — an addressable, replaceable materialized
 * view of the final swap state, keyed by ["d", swap_id].
 */
export async function publishSnapshot(
  signer: Signer,
  snapshot: SnapshotContent,
): Promise<Event> {
  const content = SnapshotContent.parse(snapshot);
  const event = await signer.signEvent({
    kind: KIND_SNAPSHOT,
    created_at: nowSeconds(),
    tags: [
      ["d", snapshot.swap_id],
      ["swap_id", snapshot.swap_id],
    ],
    content: JSON.stringify(content),
  });

  await publishEvent(event);
  return event;
}

/** Parse a 7302 event's content, or null if invalid. */
export function parseEvidence(event: Event) {
  try {
    return parseContent(EvidenceContent, event.content);
  } catch {
    return null;
  }
}

/**
 * Assemble a 30362 snapshot from a swap's request and its event history. The
 * transitions list and evidence refs are derived from the chain — the snapshot
 * is a materialized view, not a new source of truth.
 */
export function buildSnapshotContent(
  request: SwapRequestContent,
  events: Event[],
  finalState: SwapState,
): SnapshotContent {
  const view = currentStateFromHistory(events);

  const transitions = view.steps.map((s) => {
    const c = parseTransition(s.event);
    return {
      state: s.to,
      actor_role: s.role,
      at: c?.created_at ?? s.event.created_at,
      event_id: s.event.id,
    };
  });

  const evidenceRefs = events
    .filter((e) => e.kind === KIND_EVIDENCE)
    .map((e) => parseEvidence(e)?.ref)
    .filter((r): r is string => !!r);

  return SnapshotContent.parse({
    swap_id: request.swap_id,
    final_state: finalState,
    agent: request.agent,
    customer: request.customer,
    swap_type: request.swap_type,
    fiat: request.fiat,
    bitcoin: request.bitcoin,
    transitions,
    ...(evidenceRefs.length ? { evidence_refs: evidenceRefs } : {}),
    completed_at: nowSeconds(),
  });
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

type RawStep = {
  to: SwapState;
  from: SwapState;
  role: ActorRole;
  event: Event;
};

/**
 * Order a set of 7301 transitions into chain order. Nostr `created_at` is
 * second-resolution, so several transitions can share a timestamp and a plain
 * time sort is unreliable. We instead follow the prev_state → state linkage
 * from "requested", using created_at only to break ties among candidates and
 * as a fallback when no transition links to the current state (e.g. a forged or
 * out-of-order step, which replay will then flag as invalid).
 */
function orderTransitionSteps(steps: RawStep[]): RawStep[] {
  const remaining = [...steps].sort(
    (a, b) => a.event.created_at - b.event.created_at,
  );
  const ordered: RawStep[] = [];
  let current: SwapState = "requested";

  while (remaining.length) {
    let idx = remaining.findIndex((s) => s.from === current);
    if (idx === -1) idx = 0; // unlinked: take earliest, let replay flag it
    const [next] = remaining.splice(idx, 1);
    ordered.push(next);
    current = next.to;
  }
  return ordered;
}

/**
 * Derive current swap state by replaying the 7301 chain over a set of events.
 * State is ALWAYS computed this way — never stored. The 7300 establishes the
 * implicit "requested" base; each valid 7301 advances it.
 */
export function currentStateFromHistory(events: Event[]): SwapStateView {
  const requestEvent =
    events.find((e) => e.kind === KIND_SWAP_REQUEST) ?? null;

  const raw = events
    .filter((e) => e.kind === KIND_TRANSITION)
    .map((event): RawStep | null => {
      const c = parseTransition(event);
      return c
        ? { to: c.state, from: c.prev_state, role: c.actor_role, event }
        : null;
    })
    .filter((s): s is RawStep => !!s);

  const ordered = orderTransitionSteps(raw);

  const replay = replayTransitions(
    ordered.map((s) => ({ to: s.to, role: s.role })),
  );

  return {
    requestEvent,
    state: replay.state,
    ok: replay.ok,
    invalidIndex: replay.ok ? null : replay.invalidIndex,
    steps: ordered.map((s) => ({ to: s.to, role: s.role, event: s.event })),
  };
}
