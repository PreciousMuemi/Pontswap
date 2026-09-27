# PontSwap

A standalone Next.js app implementing the **Pontmore PIP-02 swap flow**: a
Nostr-native coordination layer for Bitcoin ⇄ fiat swaps. Two browser sessions
(customer + agent) complete a `fiat_to_btc` swap end to end, where every public
state change is a real Nostr event on public relays, payment instructions move
privately through NIP-59 Gift Wrap, and a final 30362 snapshot is published.

It also supports **cross-border swaps** (e.g. Uganda → Kenya, UGX in, KES out via
M-Pesa, settled in BTC) with an **AI-assisted agent recommendation**: PontSwap
filters agents by what they publish, AI explains which one fits best, and the
customer makes the final choice.

**Live demo: [https://pontswap.vercel.app](https://pontswap.vercel.app)**

> **ROLE-PLAY — no real funds move.** "Funded" and "Released" are honor-system
> buttons. There are no Lightning invoices and no escrow custody. See
> `[docs/swap-states-v1.md](docs/swap-states-v1.md)` for the state vocabulary.

## Try it in 5 minutes

You play **both sides**: an agent and a customer. Use **two different browser
windows** — e.g. a normal window and a private/incognito window — so each side
has its own identity.

### Demo agent keys

These demo agents are already published on the relays. To *be* one of them,
paste its key into the app (step 1 below).

| Demo agent | Key (paste into "Use a dev key instead") |
|---|---|
| **PontSwap Demo Agent (UG→KE)** — the AI's top pick for UG → KE | `d5fbfeecd5f8263a777dce55612ab746f3ad0b8962f31775a2e5f01dd5a803ea` |
| Kampala–Nairobi Express (demo) | `09ea64e0c714d87eece03e2ba6dbd24a05aa5bda55f7a42d874b05a07f81984a` |
| Mombasa Payouts (demo) | `25b1cefd130f0236c055da5a82962384713e8916992cb1d038ac3c97469aecac` |

> ⚠️ These are **public demo keys**. Anyone can use them. Never use them for
> anything real, and never paste a real Nostr key into a demo.

### Steps

1. **Window 1 — be the agent.** Open
   [pontswap.vercel.app/agent/inbox](https://pontswap.vercel.app/agent/inbox) →
   click **Use a dev key instead** → **paste** the *PontSwap Demo Agent* key
   above → **Use this key**. Leave this window open.
   *(Paste the key — don't click "Generate", which creates a new identity no one
   sends requests to.)*
2. **Window 2 — be the customer.** Open
   [pontswap.vercel.app](https://pontswap.vercel.app) → **Send cross-border** →
   **Use a dev key instead** → **Generate** → **Use this key**.
3. **Fill in the request:** origin country `UG`, currency `UGX`, amount `100000`,
   rail `mtn-momo`, destination `KE`, currency `KES`, payout method `mpesa`,
   sats `25000` → click **Find an agent**.
4. **See the recommendation.** The card shows the recommended agent, *why*, and
   ✓ checks for what it supports. Other eligible agents are listed below it.
5. **Choose and publish.** Click **Choose this agent**, then
   **Publish swap request**. You land in the swap room.
6. **Window 1:** the request appears in the inbox within a few seconds. Click
   **Accept**, then continue the swap from the [two-browser demo](#two-browser-demo)
   step 4 onwards.

**Tips**

- *Try `TZ` / `TZS` as the destination* to see how the AI handles two agents it
  can't tell apart ("Limited confidence").
- *"We couldn't load agents from the network"* — public relays are sometimes
  slow. Click **Try again**.
- *"AI recommendation unavailable"* is not an error: PontSwap falls back to
  ranking agents by their published capabilities.

## What this app does (and doesn't)

**Real:** live NIP-07 identities and signatures; 7300/7301/7302/30362 events on
public relays; an append-only, matrix-validated state machine; end-to-end
encrypted payment instructions via NIP-59; deterministic agent matching for
cross-border requests, with an AI explanation that is validated against the
agents' published data before it is shown.

**How the recommendation works:** agents are discovered on Nostr (kind 30360) →
a deterministic matcher keeps only agents whose published capabilities fit the
request (country, currency, payout method, limits, settlement, escrow) → AI picks
and explains one of those eligible agents, server-side → the customer chooses →
the normal swap flow continues. AI never publishes, accepts, or changes a swap,
and it never invents exchange rates, fees, or capabilities.

**Out of scope (v1):** real settlement (Lightning/escrow), exchange rates / quotes,
disputes (PIP-03), reputation/indexing, and the `btc_to_fiat` direction. The app
itself only *reads* agents (30360) and escrow descriptors (30361); publish real
agents with the reference POC at [https://poc.pontmore.xyz](https://poc.pontmore.xyz).
The demo agents above were published with `npm run agents:publish` (see below).

## Setup

Requires Node 20+ (uses the global `WebSocket`).

```bash
npm install
npm run dev      # http://localhost:3000
```

To enable the AI recommendation, create `.env.local` (git-ignored) with:

```bash
ANTHROPIC_API_KEY=your-key-here        # server-side only; never NEXT_PUBLIC_
# optional: PONTSWAP_AI_MODEL, PONTSWAP_AI_TIMEOUT_MS, PONTSWAP_AI_DISABLED=1
```

Without a key the app still works and recommends agents from their published
capabilities. On Vercel, add `ANTHROPIC_API_KEY` under *Project → Settings →
Environment Variables*.

Other scripts:

```bash
npm run build           # production build + typecheck
npm test                # matcher, AI recommendation, and view tests (AI is mocked)
npm run smoke           # publish a 7300 to the relays and read it back
npm run agent:publish   # publish one demo agent (dry run unless --publish)
npm run agents:publish  # publish the demo agent roster (dry run unless --publish)
```

Re-running `agent:publish -- --publish --secret <key>` or
`agents:publish -- --publish --seed <seed>` updates the same agents instead of
creating new ones.

Default relays (`src/config/relays.ts`): `wss://nos.lol`, `wss://relay.damus.io`,
`wss://relay.primal.net`.

## Identity

Each session needs a Nostr identity:

- **NIP-07 extension** (Alby, nos2x) — primary. Gift Wrap requires the extension
to support **NIP-44**; the UI detects and warns if it doesn't (Alby does).
- **Dev key** — an in-memory keypair for testing, clearly labeled. Click
"Use a dev key instead" → "Generate" for a new identity, or paste one of the
[demo agent keys](#demo-agent-keys) to act as that agent. Never a real identity;
no real funds.

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
- `**src/lib/matching/agent-matching.ts**` — deterministic eligibility and
ranking of agents for a cross-border request.
- `**src/lib/recommendation/**` — provider-agnostic AI recommendation with strict
output validation and a deterministic fallback; the Claude provider is
server-only.
- `**src/app/swap/new/actions.ts**` — Server Actions the recommendation card calls.

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

