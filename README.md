# PontSwap

A standalone Next.js app implementing the **Pontmore PIP-02 swap flow**: a
Nostr-native coordination layer for Bitcoin ⇄ fiat swaps. Two browser sessions
(customer + agent) complete a `fiat_to_btc` swap end to end, where every public
state change is a real Nostr event on public relays, payment instructions move
privately through NIP-59 Gift Wrap, and a final 30362 snapshot is published.

> **ROLE-PLAY — no real funds move.** "Funded" and "Released" are honor-system
> buttons. There are no Lightning invoices and no escrow custody. See
> `[docs/swap-states-v1.md](docs/swap-states-v1.md)` for the state vocabulary.

## What this app does (and doesn't)

**Real:** live NIP-07 identities and signatures; 7300/7301/7302/30362 events on
public relays; an append-only, matrix-validated state machine; end-to-end
encrypted payment instructions via NIP-59.

**Out of scope (v1):** real settlement (Lightning/escrow), disputes (PIP-03),
reputation/indexing, the `btc_to_fiat` direction, and **publishing** agents
(30360) or escrow descriptors (30361). This app is a pure *consumer* of
30360/30361 — to publish an agent, use the reference POC at
[https://poc.pontmore.xyz](https://poc.pontmore.xyz).

## Setup

Requires Node 20+ (uses the global `WebSocket`).

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts:

```bash
npm run build    # production build + typecheck
npm run smoke    # publish a 7300 to the relays and read it back
```

Default relays (`src/config/relays.ts`): `wss://nos.lol`, `wss://relay.damus.io`,
`wss://relay.primal.net`.

## Identity

Each session needs a Nostr identity:

- **NIP-07 extension** (Alby, nos2x) — primary. Gift Wrap requires the extension
to support **NIP-44**; the UI detects and warns if it doesn't (Alby does).
- **Dev key** — an in-memory keypair for testing, clearly labeled. Click
"Use a dev key instead" → "Generate". Never a real identity; no real funds.

## Two-browser demo

Use two separate browser profiles (or one normal + one private window) so each
has a **different** identity.

1. **Agent** (browser A): open `/agent/inbox` and connect an identity (a
  generated dev key is fine). Note the agent's npub.
2. **Customer** (browser B): open `/agents`, pick a discovered agent (or use the
  one from browser A by visiting `/swap/new?agent=<agent-npub>`). Connect a
   *different* identity, fill the form, and **Publish swap request**. You land in
   the swap room at `/swap/<swap_id>`.
3. **Agent** (A): the request appears in `/agent/inbox` in real time. Click
  **Accept** → you're taken to the same swap room.
4. **Agent** (A): in the swap room, mark **escrow funded**, then send
  **payment instructions** (private — gift-wrapped to the customer).
5. **Customer** (B): read the instructions in *Private messages*, then use the
  **evidence form** to post the M-Pesa code and mark **fiat sent**.
6. **Agent** (A): **Confirm fiat received**, then **Release BTC** — this records
  `released` + `completed` and immediately publishes the **30362 snapshot**.
7. Open `/swap/<swap_id>/explorer` (public, no auth) to see the full validated
  chain. Confirm no payment detail ever appears in a public event.

Both parties only ever see the buttons their role may legally take — actions are
gated by the transition matrix (`canTransition`).

## How it works

- `**src/lib/pontmore/states.ts`** — state vocabulary, transition matrix,
`canTransition` / `nextStatesFor` / `replayTransitions`.
- `**src/lib/pontmore/kinds.ts**` — zod schemas for every event payload + kind
constants.
- `**relay.ts**` — `SimplePool` wrapper (connect/publish/query/subscribe).
- `**signer.ts**` — unified NIP-07 / dev-key signer.
- `**discovery.ts**` — read-only 30360/30361 fetchers (skips malformed data).
- `**swap.ts**` — swap lifecycle: request, transitions, evidence, snapshot,
subscriptions, and state derivation.
- `**gift-wrap.ts**` — NIP-59 assembled over the signer interface.

### Relay-side filtering note

NIP-01 relays only index **single-letter** tag filters, so the spec's
`["swap_id", id]` tag cannot be queried directly (`#swap_id` returns nothing).
Every swap event therefore also carries `["d", swap_id]`, and the app filters on
`{"#d":[swapId]}` — which returns the entire chain including the snapshot. If a
relay rejects the new kinds (7300/7301/7302/30362), run a local relay instead
and point `src/config/relays.ts` at it, e.g.:

```bash
docker run -p 7000:8080 scsibug/nostr-rs-relay
# then set DEFAULT_RELAYS = ["ws://localhost:7000"]
```

## References

- PIP-00 … PIP-03: [https://github.com/pontmore/protocol](https://github.com/pontmore/protocol)
- Reference POC (publish agents/escrow): [https://poc.pontmore.xyz](https://poc.pontmore.xyz)
- NIPs: [07](https://github.com/nostr-protocol/nips/blob/master/07.md) ·
[44](https://github.com/nostr-protocol/nips/blob/master/44.md) ·
[59](https://github.com/nostr-protocol/nips/blob/master/59.md)

