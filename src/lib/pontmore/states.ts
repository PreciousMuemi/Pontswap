// lib/pontmore/states.ts
//
// Reference state vocabulary and transition matrix for PIP-02.
//
// PIP-02 deliberately does not enumerate state names; it only requires that
// transitions be append-only and sequence-coherent. This file proposes a
// concrete vocabulary for the `fiat_to_btc` swap_type, and encodes which
// actor role is permitted to drive each transition.
//
// A 7301 transition event is considered valid by clients when:
//   1. `prev_state` matches the last accepted state for the swap
//   2. the publishing actor is permitted to move from `prev_state` to `state`
//      according to the matrix below
//
// A mirrored matrix for `btc_to_fiat` is intentionally out of scope for v1.

export const SWAP_STATES = [
  "requested",
  "accepted",
  "funded",
  "fiat_sent",
  "fiat_confirmed",
  "released",
  "completed",
  "expired",
  "canceled",
  "refunded",
  "disputed",
] as const;

export type SwapState = (typeof SWAP_STATES)[number];

export const ACTOR_ROLES = ["customer", "agent", "escrow"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

const TERMINAL_STATES: ReadonlySet<SwapState> = new Set<SwapState>([
  "completed",
  "expired",
  "canceled",
  "refunded",
]);

export function isTerminal(state: SwapState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Transition matrix.
 * Outer key: current state. Inner key: actor role. Value: allowed next states.
 */
export type TransitionMatrix = Readonly<
  Record<SwapState, Readonly<Partial<Record<ActorRole, readonly SwapState[]>>>>
>;

export const FIAT_TO_BTC_TRANSITIONS: TransitionMatrix = {
  requested: {
    agent: ["accepted", "canceled", "expired"],
    customer: ["canceled"],
  },
  accepted: {
    agent: ["funded", "canceled"],
    customer: ["canceled"],
  },
  funded: {
    // Once escrow is locked, the customer cannot unilaterally cancel.
    // Backing out requires going through refund or dispute.
    customer: ["fiat_sent", "disputed"],
    agent: ["refunded", "disputed"],
  },
  fiat_sent: {
    agent: ["fiat_confirmed", "disputed"],
    customer: ["disputed"],
  },
  fiat_confirmed: {
    agent: ["released", "disputed"],
  },
  released: {
    // Either party may publish the completion acknowledgement.
    customer: ["completed"],
    agent: ["completed"],
  },
  disputed: {
    escrow: ["released", "refunded"],
  },
  // Terminal states.
  completed: {},
  expired: {},
  canceled: {},
  refunded: {},
};

export function canTransition(
  from: SwapState,
  to: SwapState,
  role: ActorRole,
  matrix: TransitionMatrix = FIAT_TO_BTC_TRANSITIONS,
): boolean {
  const allowed = matrix[from]?.[role];
  return !!allowed && allowed.includes(to);
}

export function nextStatesFor(
  state: SwapState,
  role: ActorRole,
  matrix: TransitionMatrix = FIAT_TO_BTC_TRANSITIONS,
): readonly SwapState[] {
  return matrix[state]?.[role] ?? [];
}

/**
 * Apply a sequence of (state, role) transitions starting from "requested"
 * and return either the resulting state or the index of the first invalid
 * transition. Useful for validating a 7301 chain pulled from a relay.
 */
export function replayTransitions(
  steps: ReadonlyArray<{ to: SwapState; role: ActorRole }>,
  matrix: TransitionMatrix = FIAT_TO_BTC_TRANSITIONS,
):
  | { ok: true; state: SwapState }
  | { ok: false; invalidIndex: number; state: SwapState } {
  let current: SwapState = "requested";
  for (let i = 0; i < steps.length; i++) {
    const { to, role } = steps[i];
    if (!canTransition(current, to, role, matrix)) {
      return { ok: false, invalidIndex: i, state: current };
    }
    current = to;
  }
  return { ok: true, state: current };
}
