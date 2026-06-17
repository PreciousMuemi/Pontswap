# Pontmore Swap State Vocabulary — v1 (fiat → BTC)

> Status: **draft / proposal.** This document proposes a concrete state
> vocabulary and transition matrix for the PIP-02 swap state machine. PIP-02
> deliberately does **not** enumerate state names — it only requires that
> transitions be append-only and sequence-coherent. This is one opinionated
> realization of that contract, scoped to the `fiat_to_btc` direction. It is
> intended as the seed of a future PIP.

## 1. Scope

- **Direction:** `fiat_to_btc` only. The `btc_to_fiat` mirror is intentionally
  out of scope for v1. Schemas accept the value; clients should fail closed.
- **Settlement:** out of scope. "Funded" and "Released" are coordination
  signals, not custody operations. No Lightning invoices, no escrow custody.
- **Disputes:** the `disputed` state exists in the matrix (so the chain can
  represent a dispute) but resolution is delegated to PIP-03 and has no UI here.

## 2. Actors

Three actor roles drive transitions. There is **no system/automation actor** —
every state change is attributable to a human party's key.

| Role       | Who                                                        |
| ---------- | ---------------------------------------------------------- |
| `customer` | The party paying fiat and receiving BTC.                   |
| `agent`    | The counterparty providing BTC liquidity for fiat.        |
| `escrow`   | A neutral custody/arbitration role. Only acts on disputes. |

## 3. States

```
requested → accepted → funded → fiat_sent → fiat_confirmed → released → completed
    |           |          |          |             |             |
 expired     canceled   refunded   disputed      disputed      refunded
            (canceled)           (disputed)
```

Eleven states total. **Terminal states** (no outgoing transitions):
`completed`, `expired`, `canceled`, `refunded`.

| State            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `requested`      | Customer published a 7300; awaiting agent.                    |
| `accepted`       | Agent agreed to the swap.                                     |
| `funded`         | Escrow considered funded (role-play in this app).             |
| `fiat_sent`      | Customer asserts the fiat leg was paid; evidence attached.    |
| `fiat_confirmed` | Agent confirms receipt of the fiat.                           |
| `released`       | Agent released the BTC (role-play).                           |
| `completed`      | Swap acknowledged complete by a party. **Terminal.**          |
| `expired`        | Request lapsed before acceptance. **Terminal.**               |
| `canceled`       | Backed out before escrow lock. **Terminal.**                  |
| `refunded`       | Funds returned to the customer after funding. **Terminal.**   |
| `disputed`       | Escalated; resolution deferred to escrow (PIP-03).            |

## 4. Transition matrix

Outer key = current state; inner key = the role permitted to drive the move.

| From → To        | `customer`            | `agent`                         | `escrow`              |
| ---------------- | --------------------- | ------------------------------- | --------------------- |
| `requested`      | `canceled`            | `accepted`, `canceled`, `expired` | —                   |
| `accepted`       | `canceled`            | `funded`, `canceled`            | —                     |
| `funded`         | `fiat_sent`, `disputed` | `refunded`, `disputed`        | —                     |
| `fiat_sent`      | `disputed`            | `fiat_confirmed`, `disputed`    | —                     |
| `fiat_confirmed` | —                     | `released`, `disputed`          | —                     |
| `released`       | `completed`           | `completed`                     | —                     |
| `disputed`       | —                     | —                               | `released`, `refunded` |

Two deliberate asymmetries worth calling out:

1. **The customer cannot unilaterally cancel after `funded`.** Once escrow is
   considered locked, backing out must go through `refunded` (agent) or
   `disputed`. This prevents a customer from stranding a funded swap.
2. **No actor can fabricate `completed` before `released`.** Completion is only
   reachable from `released`, and `released` is only reachable from
   `fiat_confirmed` — the agent cannot release before confirming fiat receipt.

## 5. Validity rules

A 7301 transition event is accepted by a client when **all** hold:

1. `prev_state` matches the last accepted state for the swap.
2. The publishing actor's role is permitted to move `prev_state → state` per the
   matrix above.
3. The event is append-only — it never mutates a prior event.

Current state is **always derived** by replaying the 7301 chain from the
implicit `requested` base; it is never stored as an independent source of truth.

### Chain ordering

Nostr `created_at` is second-resolution, and several transitions can legitimately
share a timestamp (e.g. an agent publishing `released` and `completed` back to
back). Ordering the chain purely by `created_at` is therefore unreliable.
Clients should order transitions by **`prev_state → state` linkage** (walking
from `requested`), using `created_at` only as a tiebreak. A transition that
links to no current state, or that the matrix rejects, is flagged invalid and
halts derivation at the last valid state.

## 6. Event kinds

| Kind    | PIP    | Role in this vocabulary                                  |
| ------- | ------ | -------------------------------------------------------- |
| `30360` | PIP-00 | Agent definition (consumed; published elsewhere).        |
| `30361` | PIP-01 | Escrow descriptor (consumed; published elsewhere).       |
| `7300`  | PIP-02 | Swap request — immutable. Establishes `requested`.       |
| `7301`  | PIP-02 | State transition — append-only.                          |
| `7302`  | PIP-02 | Evidence — reveal-by-reference.                          |
| `7304`  | —      | Optional operational note.                               |
| `30362` | PIP-02 | Snapshot — materialized view of the final state.         |
| `1059`  | NIP-59 | Gift wrap — private payment instructions / artifacts.    |

## 7. Tag conventions

- Every swap event carries `["swap_id", <id>]` (human-readable; also inside the
  content).
- Every swap event **also** carries `["d", <swap_id>]`. This is the tag clients
  actually filter on: NIP-01 relays only index **single-letter** tag filters, so
  a multi-letter `#swap_id` filter returns nothing on standard relays (verified
  against `nos.lol` and `relay.damus.io`). Because the 30362 snapshot already
  keys on `["d", swap_id]`, a single `{"#d":[swapId]}` filter returns the whole
  chain including the snapshot.
- `7300` additionally carries `["p", <agent_pubkey>]` for agent notification.
- `7301` / `7302` additionally carry `["e", <request_event_id>]` linking to the
  originating 7300.
- Gift-wrapped messages carry only `["p", <recipient>]`. The `swap_id` lives
  **inside the encrypted rumor**, never as a public tag — so a swap's public
  chain (queried by `#d`) structurally cannot surface its private messages.

## 8. Evidence model

Evidence (7302) is **reveal-by-reference**:

- `ref` — an opaque public reference, e.g. an M-Pesa transaction code. Safe to
  publish; meaningful only to the counterparties and the rails operator.
- `ref_hash` — the SHA-256 of a private artifact (e.g. a payment screenshot).
  The artifact itself is sent privately via gift wrap; only its hash is ever
  committed, allowing later integrity checks without public disclosure.

At least one of `ref` / `ref_hash` is required.

## 9. Private messaging (NIP-59)

Payment instructions (till/paybill, amount, reference) flow agent → customer as
a NIP-59 gift wrap (kind 1059). The wrap is signed by a throwaway ephemeral key;
the inner seal (kind 13) is signed by the agent and encrypts a rumor (kind 14)
to the customer. No payment detail and no `swap_id` appears in any public event.

## 10. Snapshot (30362)

A snapshot is a **materialized view**, not a new source of truth. It is
addressable/replaceable (`["d", swap_id]`) and records the final state, the
parties, the legs, the ordered transition list (with event ids), and the public
evidence refs. Clients should still treat the 7301 chain as authoritative and
use the snapshot only as a convenience index.

## 11. Open questions / future work

- A mirrored matrix for `btc_to_fiat`.
- Dispute resolution semantics (PIP-03): who may publish escrow transitions, and
  how the `disputed → released/refunded` decision is authorized.
- Expiry enforcement: `expired` is currently an agent-driven transition; a
  purely time-based expiry (derived from `7300.expiry`) may be preferable.
- Handling competing transitions from the same `prev_state` (forks) beyond
  "earliest valid wins."
