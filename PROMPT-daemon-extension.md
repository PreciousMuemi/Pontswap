# PROMPT — Agent automation daemon (extends the standalone swap app)

## Where this fits

This extends the standalone Next.js app specified in `PROMPT.md` (the Pontmore
PIP-02 swap flow scaffolded fresh with `create-next-app`, `src/` dir). It is NOT a
fork of `pontmore/nextjs-poc`. It adds an automation layer so the AGENT side runs
unattended: auto-accept in-policy requests, auto-release BTC after the agent attests
fiat, and alert on low float — the "mobile-money agent tool" angle.

The automation lives in a long-running Node process at `scripts/daemon.ts`, run with
`tsx` (consistent with the existing `scripts/` convention). A skeleton already exists —
paste it in if it is not present. The daemon REUSES the app's `src/lib/pontmore/`
modules; it does not reimplement the Nostr layer.

## Two deliberate departures from PROMPT.md — keep them honest

1. **Real BTC settlement.** `PROMPT.md` is role-play: honor-system `funded` / `released`
   buttons and a `no real funds move` banner. This automation path moves REAL sats on
   the BTC leg via phoenixd, for the agent's release only. Update the banner to be
   accurate: the fiat leg is attested / role-play, the BTC leg is real (tiny mainnet or
   testnet). Everything else stays role-play.
2. **A local store + control process.** `PROMPT.md` says the relay is the database and
   the app is browser-only. The daemon adds a small SQLite store and an HTTP control
   server. Scope this tightly: SQLite holds ONLY daemon-local operational data (float
   snapshots, policy, alerts, ledger, an auto/manual decision flag). Swap STATE is still
   derived from the 7301 chain via `replayTransitions()` exactly as `PROMPT.md` requires.
   Never treat SQLite as the swap-state source of truth.

A browser tab can be closed; auto-release cannot live there. That is why the daemon is a
separate process — state it that way if asked.

## Reuse, don't reinvent

The daemon MUST go through the app's existing modules. Refactor the skeleton's
hand-rolled `SimplePool` and raw `JSON.parse` out and route everything through:

- `src/lib/pontmore/relay.ts` — one relay client. Do not open a second pool.
- `src/lib/pontmore/swap.ts` — `subscribeAgentInbox`, `subscribeSwap`,
  `appendTransition`, `publishSnapshot`, `fetchSwapHistory`.
- `src/lib/pontmore/signer.ts` — `getDevSigner(AGENT_SECRET_HEX)`. NIP-07 is
  browser-only; the daemon signs with the agent's in-memory dev key.
- `src/lib/pontmore/kinds.ts` — parse content with `parseContent(Schema, ...)`.
- `src/lib/pontmore/gift-wrap.ts` — decrypt the customer's private LN payout destination.
- `src/lib/pontmore/states.ts` — `canTransition()` before every transition.

## Identity model

The daemon IS the agent (same pubkey). It signs `accepted` / `funded` /
`fiat_confirmed` / `released` transitions with the agent key. The human agent's browser
dashboard is the cockpit: it monitors, supplies the fiat-received attestation, and tunes
policy. The daemon never holds the customer's keys.

## Mapping the automation onto the PROMPT.md state machine

Use the real `states.ts` vocabulary and real transitions — do not invent status strings
on the relay:

- 7300 `requested` arrives (`subscribeAgentInbox`) -> policy check.
  - in policy -> `appendTransition` to `accepted` (agent), then `funded` (agent) once the
    float reserve is confirmed.
  - out of policy -> leave at `requested`, record `manual_review` locally only (no relay
    event).
- Customer publishes `fiat_sent` (seen via `subscribeSwap`).
- Human agent taps "fiat received" in the cockpit -> control endpoint ->
  `appendTransition` to `fiat_confirmed` (agent).
- Daemon auto-releases: phoenixd pays the customer's LN destination -> on success
  `appendTransition` to `released` (agent) -> `publishSnapshot` 30362 with
  `final_state: completed`.

Gate every transition with `canTransition()` and re-check the reserve immediately before
release.

## Customer payout destination

`PROMPT.md`'s 7300 carries a bitcoin-leg type but no destination. Add a bidirectional
gift-wrap step: after `accepted`, the customer gift-wraps a reusable Lightning address to
the agent (stays private per the tag conventions). The daemon decrypts it and pays via
phoenixd `/paylnaddress` with `amountSat` at release time. Prefer a Lightning address over
a one-time invoice to avoid expiry races during the demo.

## phoenixd settlement (behind the Settlement interface)

Keep every phoenixd call inside `PhoenixdSettlement`:

- `getBalanceSat` -> `GET /getbalance`
- `release` -> `POST /paylnaddress` (or `/payinvoice`), stamp `externalId = swapId`
- `createTopUp` -> `POST /createinvoice`, `externalId = "topup:<swapId>"`

Subscribe the phoenixd websocket for `payment_received` (top-ups and correlation by
`externalId`). `SETTLEMENT=mock|phoenixd|cashu` switches adapters with zero rules-engine
change.

## Control surface + cockpit

Daemon HTTP control server on `CONTROL_PORT`, with CORS allowing the dev origin
(`http://localhost:3000`):

- `POST /swaps/:id/confirm-fiat` -> `fiat_confirmed` + auto-release
- `GET /state` -> settlement name, float, policy, swaps
- `POST /policy` -> update policy

Dashboard pages under `src/app/agent/`:

- extend `agent/inbox/page.tsx` with `auto` / `manual` badges
- add `agent/console/page.tsx`: float + reserve + low-float alert + top-up button;
  active swaps each with a "fiat received" button; policy controls; ledger.

The dashboard READS via `GET /state` (poll every 2s) and WRITES only via the control
endpoints. It never calls phoenixd directly.

## Phases — verify the gate before advancing

1. **Refactor onto shared modules.** Move the skeleton to `scripts/daemon.ts`; route
   Nostr through `relay.ts` / `swap.ts`, signing through `signer.ts`. Gate: daemon boots,
   `subscribeAgentInbox` logs a real 7300, exactly one relay pool exists.
2. **Policy + guards.** Finish `evaluatePolicy` with the amount cap, reserve check, and a
   `canTransition()` guard; add a dynamic low-float threshold (`< 3 x avg swap size`,
   falling back to the static value). Gate: over-cap -> manual, breach-reserve -> manual,
   in-policy -> auto.
3. **Auto accept + funded (mock).** Publish `accepted` then `funded` via
   `appendTransition`. Gate: a second Nostr client sees both with correct
   `swap_id` / `e` tags.
4. **Fiat attestation -> auto-release (mock).** `confirm-fiat` -> `fiat_confirmed` ->
   `released` -> 30362 `completed`. Gate: full `requested -> completed` chain on mock;
   release impossible before `fiat_confirmed` or below reserve.
5. **phoenixd live.** Implement `PhoenixdSettlement`; pull the customer LN address from
   the gift-wrap; correlate by `externalId`; wire top-ups. Gate: flip
   `SETTLEMENT=phoenixd`, run once with tiny real sats, no rules-engine change.
6. **Cockpit.** Build `agent/console`. Gate: two browsers — customer and agent console —
   show `requested -> accepted -> funded -> fiat_sent -> fiat_confirmed -> released ->
   completed` live, with the float dropping and the alert firing at the threshold.

## Acceptance criteria

1. A real 7300 over a public relay appears in the cockpit within ~2s.
2. In-policy requests auto-accept; out-of-policy route to manual review.
3. Release only happens after `fiat_confirmed`, never breaching the reserve, in BOTH the
   mock and phoenixd adapters.
4. `released` and the 30362 `completed` snapshot are real Nostr events with correct tags.
5. No payment detail and no `swap_id` leak in any public event — the customer's LN address
   and the agent's M-Pesa instructions both travel via gift-wrap.
6. Flipping `SETTLEMENT` between `mock` and `phoenixd` requires no rules-engine change.
7. The banner accurately states: fiat leg role-play, BTC leg real.
8. `npm run build` passes; the cockpit runs without console errors on the happy path.

## Deferred — unchanged from PROMPT.md

`btc_to_fiat` direction, disputes (7303 / PIP-03), real escrow / hold invoices,
reputation / aggregation / indexer, and agent / escrow publishing (30360 / 30361).
Discovery stays read-only.
