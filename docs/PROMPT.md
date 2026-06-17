# Pontmore Swap Flow — Implementation Spec (Standalone App)

## Mission

Build a **fresh, standalone Next.js application** that implements the Pontmore PIP-02 swap flow. Two browser sessions (customer + agent) must be able to complete a fiat-to-BTC swap end-to-end, where every public state change is a real Nostr event on the configured relays, sensitive payloads move through Gift Wrap, and a final snapshot (kind 30362) is published.

This is a NEW project — not a fork, not an addition to the existing POC. You are scaffolding from zero.

## Context

Pontmore is a Nostr-native coordination layer for Bitcoin <-> fiat swaps. The protocol is defined at https://github.com/pontmore/protocol (PIP-00 through PIP-03). **Read PIP-02 (swap state machine) before writing any code.**

The protocol defines these event kinds:

- **30360** — agent definition (PIP-00). Already published by existing agents on the network.
- **30361** — escrow descriptor (PIP-01). Already published.
- **7300** — swap request (PIP-02). This app creates these.
- **7301** — state transition (PIP-02). This app creates these.
- **7302** — evidence (PIP-02). This app creates these.
- **7304** — operational note (optional).
- **30362** — swap snapshot (PIP-02). This app creates these.

This app is a **pure consumer of existing 30360/30361 events** (for agent/escrow discovery) and the **sole producer of 7300/7301/7302/30362 events** (the swap lifecycle). It does NOT implement agent or escrow *publishing* — those already exist in the reference POC at https://poc.pontmore.xyz. Users who want to publish an agent definition use that POC; this app consumes what they published.

## Why standalone

A fresh project avoids coupling to the reference POC's structure and lets the swap flow ship independently. The cost is that the Nostr plumbing (relay client, signer integration, discovery reads) must be built here rather than inherited. This spec covers that plumbing explicitly.

## Tech stack

- **Next.js** (App Router) + **TypeScript**, strict mode
- **Tailwind CSS** for styling
- **zod** for schema validation
- **nostr-tools** v2 for relay connections, event signing, NIP-44, NIP-59 — prefer its built-in implementations over hand-rolling crypto
- **NIP-07** browser extension signer (Alby / nos2x) as the primary identity method, with an optional in-memory local keypair for testing (clearly labeled, dev-only)
- No global state library — React state + `useEffect` with subscription cleanup
- `tsx` for standalone scripts

Scaffold with `npx create-next-app@latest` (TypeScript, Tailwind, App Router, `src/` dir, no ESLint prompt blocking). Then `npm install nostr-tools zod`.

## Hard scope cuts

Do not implement, even if it seems easy:

- Real escrow execution. No Lightning hold invoices, no real money. "Funded" and "Released" are honor-system buttons with a persistent `ROLE-PLAY — no real funds move` banner on every swap page.
- Disputes (kind 7303 / PIP-03). The `disputed` state exists in the matrix but has no resolution UI.
- Reputation, aggregation, indexer.
- Agent or escrow **publishing** (kinds 30360 / 30361). Discovery reads only. Direct users to the reference POC to publish.
- The `btc_to_fiat` direction. Schemas allow the value; the state matrix only covers `fiat_to_btc`. Fail closed at the UI with "v1 only supports fiat -> BTC."
- Auth backends, databases, server-side persistence. The relay network IS the database. The only server code is whatever Next.js needs for routing; everything reads from / writes to relays.
- New state-management libraries.

## Foundation files (already written — drop in first)

Two files are already designed. Place them at `src/lib/pontmore/`:

- `states.ts` — reference state vocabulary, transition matrix, `canTransition()`, `nextStatesFor()`, `replayTransitions()`, `isTerminal()`
- `kinds.ts` — zod schemas for all event content payloads, kind number constants, `coordinate()` and `parseContent()` helpers

If they are not present when you start, ask the user to drop them in. Do not regenerate them from scratch — they encode deliberate design decisions (string amounts, three actor roles, no-system-actor, customer-can't-cancel-after-funded).

## State vocabulary (summary)

```
requested -> accepted -> funded -> fiat_sent -> fiat_confirmed -> released -> completed
     |          |          |           |             |              |
  expired   canceled   refunded    disputed      disputed       refunded
```

Every action button in the UI MUST be gated by `canTransition(currentState, targetState, myRole)`. Never render an action the current actor cannot legally take. Current state is always computed by replaying the 7301 chain with `replayTransitions()`, never stored locally as source of truth.

## Files to create

```
src/lib/pontmore/
  states.ts           <- (provided)
  kinds.ts            <- (provided)
  relay.ts            <- relay pool: connect, publish, subscribe, query. Built on nostr-tools SimplePool.
  signer.ts           <- NIP-07 detection + optional dev local keypair; unified sign() interface
  discovery.ts        <- read-only fetchers for 30360 agents + 30361 escrow descriptors
  swap.ts             <- swap lifecycle publish/subscribe helpers (API below)
  gift-wrap.ts        <- NIP-44 + NIP-59 via nostr-tools
  nip19.ts            <- npub <-> hex helpers at the UI edge

src/app/
  layout.tsx                  <- root layout, relay + signer context providers
  page.tsx                    <- landing: explain the app, link to agent browse + sign in
  agents/page.tsx             <- browse discovered 30360 agents (read 30361 for escrow detail)
  swap/new/page.tsx           <- swap request form (customer)
  swap/[id]/page.tsx          <- swap room (used by both parties)
  swap/[id]/explorer/page.tsx <- read-only event timeline (public, no auth)
  agent/inbox/page.tsx        <- agent's incoming swap requests

src/components/
  SignerGate.tsx              <- prompts for NIP-07 / dev key, exposes pubkey to children
  RelayStatus.tsx             <- shows connected relay count
  agents/AgentCard.tsx        <- one 30360, with "Start swap" CTA
  swap/StateTimeline.tsx      <- vertical timeline of transitions
  swap/ActionButton.tsx       <- gated by canTransition()
  swap/GiftWrapPanel.tsx      <- decrypted private messages for this swap
  swap/EvidenceForm.tsx       <- post a kind 7302 evidence event
  swap/RolePlayBanner.tsx     <- persistent visual reminder

src/config/
  relays.ts                   <- default relay list

docs/
  swap-states-v1.md           <- write up the proposed state vocabulary

scripts/
  smoke-test-swap.ts          <- publishes a 7300 and queries it back; run with tsx
```

## Plumbing specs (build these — nothing to inherit)

### `relay.ts`
Wrap nostr-tools `SimplePool`. Expose:
```typescript
getPool(): SimplePool
publishEvent(signedEvent: Event): Promise<void>   // publish to all configured relays
queryEvents(filters: Filter[]): Promise<Event[]>   // one-shot, dedup by id, with timeout
subscribe(filters: Filter[], onEvent: (e: Event) => void): () => void  // returns unsubscribe
```
Relays come from `src/config/relays.ts`. Default: `["wss://nos.lol", "wss://relay.damus.io"]`. Handle connection failures gracefully — a dead relay must not block the others.

### `signer.ts`
Unified interface so UI never branches on signer type:
```typescript
type Signer = {
  getPublicKey(): Promise<string>;          // hex
  signEvent(unsigned: EventTemplate): Promise<Event>;
  nip44Encrypt(peerHex: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerHex: string, ciphertext: string): Promise<string>;
};
getNip07Signer(): Signer | null              // window.nostr, null if absent
getDevSigner(secretKeyHex: string): Signer   // in-memory, dev only, clearly labeled in UI
```
If a NIP-07 extension lacks NIP-44 support (they differ — Alby vs nos2x), detect it and surface a clear UI message rather than failing silently.

### `discovery.ts`
Read-only:
```typescript
fetchAgents(opts?: { limit?: number }): Promise<AgentDefinition[]>   // kind 30360, parsed via zod
fetchAgent(pubkeyHex: string): Promise<AgentDefinition | null>
fetchEscrowDescriptor(coordinate: string): Promise<EscrowDescriptor | null>  // 30361 by coordinate
```
Parse with the zod schemas in `kinds.ts`. Skip (don't throw on) events that fail validation — the network has malformed demo data.

## `swap.ts` API surface

```typescript
publishSwapRequest(signer, params): Promise<{ event: Event; swapId: string }>
appendTransition(signer, params: {
  swapId: string; state: SwapState; prevState: SwapState;
  actorRole: ActorRole; reason: string; requestEventId: string;
}): Promise<Event>
postEvidence(signer, params: {
  swapId: string; type: string; ref?: string; refHash?: string; note?: string;
}): Promise<Event>
publishSnapshot(signer, snapshot: SnapshotContent): Promise<Event>
subscribeAgentInbox(agentPubkey: string, onSwapRequest: (e: Event) => void): () => void
subscribeSwap(swapId: string, onEvent: (e: Event) => void): () => void
fetchSwapHistory(swapId: string): Promise<Event[]>
```

All content validated via the zod schemas in `kinds.ts`. Use `parseContent(SwapRequestContent, event.content)` — never raw `JSON.parse`. Generate `swap_id` with a ULID or `crypto.randomUUID()`.

## Tag conventions

- Every swap-related event: `["swap_id", <id>]` for relay-side filtering
- `7300` request: `["p", <agent_pubkey>]` for notification, `["swap_id", <id>]`
- `7301` / `7302`: `["e", <request_event_id>]` linking to the originating 7300, `["swap_id", <id>]`
- `30362` snapshot: `["d", <swap_id>]` (addressable), `["swap_id", <id>]`
- Gift-wrapped messages: `swap_id` lives inside the inner kind-14 content, never as a public tag

## Order of work

Verify after each phase before moving on. Commit at the end of each phase with a conventional message.

1. **Scaffold.** `create-next-app`, install deps, drop in `states.ts` + `kinds.ts`, confirm `npm run build` passes. Commit: `chore: scaffold standalone swap app`.

2. **Plumbing.** Build `relay.ts`, `signer.ts`, `nip19.ts`, `config/relays.ts`. Build `SignerGate` and `RelayStatus`. Verify: a page can connect to relays, show connection count, and display the signed-in pubkey. Commit.

3. **Discovery.** Build `discovery.ts` + `agents/page.tsx` + `AgentCard`. Verify: the page lists real 30360 agents already on `nos.lol` / `relay.damus.io` (the existing demo agents should appear). Commit.

4. **Smoke test.** Implement `publishSwapRequest`, `fetchSwapHistory` in `swap.ts`. Write `scripts/smoke-test-swap.ts` that publishes a 7300 and queries it back. **Do not proceed until this round-trip works against a real relay.** Commit.

5. **Request form.** `swap/new/page.tsx`. Reads `?agent=<npub>`, fetches that agent's 30360 + its selected 30361, renders the form, publishes a 7300 on submit, redirects to `/swap/<swap_id>`. The "Start swap" CTA on `AgentCard` links here. Commit.

6. **Agent inbox.** `agent/inbox/page.tsx` via `subscribeAgentInbox`. Incoming 7300s render as cards with Accept / Decline. Accept publishes a 7301 `accepted` and navigates to the swap room. Commit.

7. **Swap room.** `swap/[id]/page.tsx`. Fetch history on mount, then subscribe live. Compute current state with `replayTransitions()`. Render `StateTimeline`. Render only buttons from `nextStatesFor(currentState, myRole)`. Both parties use this page. Commit.

8. **Gift Wrap.** `gift-wrap.ts` (NIP-44 + NIP-59 via nostr-tools). After accept, agent enters payment instructions (M-Pesa Till, amount, reference) and gift-wraps them to the customer. Customer's room subscribes to inbound 1059 events and decrypts into `GiftWrapPanel`. Payment details NEVER appear in a public event. Commit.

9. **Evidence + transitions.** `EvidenceForm` posts a 7302 with the M-Pesa code as `ref` (screenshot, if any, goes private via gift wrap as `ref_hash`), transitions to `fiat_sent`. Agent "Confirm receipt" -> `fiat_confirmed`. Agent "Release" -> `released`, then immediately publish a 30362 snapshot with `final_state: completed`. One commit per button, each verified in two browsers.

10. **Explorer.** `swap/[id]/explorer/page.tsx` — read-only, public, no auth. Accepts any `swap_id`, renders the full event chain chronologically, validates via `replayTransitions()`, visibly flags any invalid step. Commit.

11. **Polish.** `RolePlayBanner` on every `swap/` and `agent/` page. Failure branches: `expired` and `canceled` (before `funded`). Landing page copy explaining what's real and what's role-play. Write `docs/swap-states-v1.md` carefully — it's the seed of a future PIP. Update `README.md` with setup + two-browser demo instructions. Commit.

## Acceptance criteria

Done when ALL are true:

1. Two browser sessions (customer + agent, different npubs) complete `requested -> accepted -> funded -> fiat_sent -> fiat_confirmed -> released -> completed` with a 30362 snapshot, on a public relay.
2. `agents/page.tsx` lists real 30360 agents already on the network.
3. Agent inbox shows incoming 7300s in real time without manual refresh.
4. Action buttons are gated by `canTransition()` — no role ever sees an illegal button.
5. Payment instructions flow agent -> customer via NIP-59 Gift Wrap. Verified: no `swap_id` and no payment detail appears in any public event from the agent.
6. Swap explorer renders + validates the full chain for any `swap_id`.
7. `npm run build` passes with no TypeScript errors.
8. `npm run dev` runs without console errors during the happy path.
9. `docs/swap-states-v1.md` and a demo-ready `README.md` exist.

## Conventions and constraints

- **Pubkey format**: internal code uses 64-char hex (matches the schemas). Convert npub <-> hex only at the UI edge via `nip19.ts`.
- **Amounts**: always strings (`"5000"`, `"3200000"`). Never floats, never coerce before display.
- **Current state is derived, never stored**: always recompute from the 7301 chain.
- **Crypto**: use nostr-tools' NIP-44 / NIP-59 implementations. Do not hand-roll encryption.
- **Commits**: small, atomic, conventional (`feat(swap):`, `feat(sdk):`, `fix(swap):`).
- **Default relays**: `wss://nos.lol`, `wss://relay.damus.io`. If both reject kind 7300, document it and add a local `nostr-rs-relay` Docker option to the README.

## When to ask the user, not guess

Ask before proceeding if:
- A relay rejects one of the new kinds (7300/7301/7302/30362)
- The NIP-07 signer in the test environment doesn't support NIP-44
- The existing 30360/30361 events on the network don't match the zod schemas in `kinds.ts` (schema may need adjusting to real demo data)
- nostr-tools' NIP-59 API differs from what this spec assumes

For style, naming, file structure, and minor design questions, decide and move on. Match conventional Next.js + Tailwind patterns.

## Reference

- PIP-00: https://github.com/pontmore/protocol/blob/main/PIP-00-agent-definition.md
- PIP-01: https://github.com/pontmore/protocol/blob/main/PIP-01-escrow-descriptor.md
- PIP-02: https://github.com/pontmore/protocol/blob/main/PIP-02-swap-state-machine.md
- PIP-03 (context only, do not implement): https://github.com/pontmore/protocol/blob/main/PIP-03-dispute-policy.md
- Reference POC (for publishing agents/escrow, and as a UI reference): https://poc.pontmore.xyz — source at https://github.com/pontmore/nextjs-poc
- nostr-tools: https://github.com/nbd-wtf/nostr-tools
- NIP-07 (signer): https://github.com/nostr-protocol/nips/blob/master/07.md
- NIP-44 (encryption): https://github.com/nostr-protocol/nips/blob/master/44.md
- NIP-59 (gift wrap): https://github.com/nostr-protocol/nips/blob/master/59.md
