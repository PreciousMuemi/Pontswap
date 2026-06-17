/**
 * daemon.ts — Pontmore agent automation daemon (SKELETON)
 * --------------------------------------------------------
 * A single long-running process that holds two live connections open:
 *   1. a Nostr relay subscription  -> incoming swap requests (Pontmore events)
 *   2. the phoenixd websocket       -> incoming Lightning payments
 * It owns a SQLite db (swaps, ledger, alerts, policy). The Next.js dashboard
 * READS that db directly and WRITES via this daemon's small HTTP control surface,
 * so the daemon stays the single writer/orchestrator of swap state.
 *
 * DO NOT run this inside a Next.js API route — serverless will tear the two
 * subscriptions down between requests and the automation silently stops.
 *
 * Install:  npm i nostr-tools ws better-sqlite3 dotenv
 *           npm i -D tsx @types/ws @types/better-sqlite3
 * Run:      npx tsx daemon.ts
 *
 * Env (.env):
 *   RELAYS=wss://relay.damus.io,wss://nos.lol
 *   AGENT_PUBKEY=<hex>                 # filter requests addressed to this agent (#p tag)
 *   AGENT_NSEC=<nsec...>               # needed once you publish accept/completed events
 *   SETTLEMENT=mock                    # mock | phoenixd | cashu
 *   PHOENIXD_URL=http://127.0.0.1:9740
 *   PHOENIXD_WS=ws://127.0.0.1:9740/websocket
 *   PHOENIXD_PASSWORD=<http-password from ~/.phoenix/phoenix.conf>
 *   CONTROL_PORT=8787
 *   DB_PATH=./agent.db
 */

import 'dotenv/config';
import http from 'node:http';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';

// nostr-tools needs a WebSocket impl in Node
useWebSocketImplementation(WebSocket);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RELAYS = (process.env.RELAYS ?? 'wss://relay.damus.io').split(',').map(s => s.trim());
const AGENT_PUBKEY = process.env.AGENT_PUBKEY ?? '';
const SETTLEMENT = (process.env.SETTLEMENT ?? 'mock') as 'mock' | 'phoenixd' | 'cashu';
const PHOENIXD_URL = process.env.PHOENIXD_URL ?? 'http://127.0.0.1:9740';
const PHOENIXD_WS = process.env.PHOENIXD_WS ?? 'ws://127.0.0.1:9740/websocket';
const PHOENIXD_PASSWORD = process.env.PHOENIXD_PASSWORD ?? '';
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? './agent.db';

// TODO: replace these with the real kind numbers exported from your kinds.ts
// (per protocol: swap lifecycle lives in 7300 / 7301 / 7302; swap state in 30362)
const SWAP_REQUEST_KINDS = [7300];

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Store (SQLite) — single source of truth, shared read-only with the dashboard
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS swaps (
    id            TEXT PRIMARY KEY,        -- swap id (also used as phoenixd externalId)
    customer_pk   TEXT,
    amount_sat    INTEGER,
    invoice       TEXT,                    -- customer payout invoice / ln-address
    direction     TEXT DEFAULT 'fiat_to_btc',
    status        TEXT,                    -- align with states.ts vocabulary
    created_at    INTEGER,
    updated_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    swap_id     TEXT,
    amount_sat  INTEGER,
    kind        TEXT,                      -- 'release' | 'topup' | 'fee'
    ts          INTEGER
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    level  TEXT,
    msg    TEXT,
    ts     INTEGER,
    seen   INTEGER DEFAULT 0
  );
`);

const upsertSwap = db.prepare(`
  INSERT INTO swaps (id, customer_pk, amount_sat, invoice, direction, status, created_at, updated_at)
  VALUES (@id, @customer_pk, @amount_sat, @invoice, @direction, @status, @ts, @ts)
  ON CONFLICT(id) DO UPDATE SET status=@status, updated_at=@ts
`);
const getSwap = db.prepare(`SELECT * FROM swaps WHERE id = ?`);
const setStatus = db.prepare(`UPDATE swaps SET status=?, updated_at=? WHERE id=?`);
const addLedger = db.prepare(`INSERT INTO ledger (swap_id, amount_sat, kind, ts) VALUES (?,?,?,?)`);
const addAlert  = db.prepare(`INSERT INTO alerts (level, msg, ts) VALUES (?,?,?)`);

// ---------------------------------------------------------------------------
// Policy — the safety layer. "Auto" is only safe because of these gates.
// ---------------------------------------------------------------------------
interface AgentPolicy {
  autoAcceptEnabled: boolean;
  maxAutoReleaseSat: number;   // only auto-release below this size
  minFloatReserveSat: number;  // never let float drop below this
  lowFloatThresholdSat: number;// fire an alert below this
}

let policy: AgentPolicy = {
  autoAcceptEnabled: true,
  maxAutoReleaseSat: 50_000,
  minFloatReserveSat: 20_000,
  lowFloatThresholdSat: 100_000,
};

type SwapRequest = { id: string; customerPk: string; amountSat: number; invoice: string };

function evaluatePolicy(req: SwapRequest, floatSat: number): { decision: 'auto' | 'manual'; reason: string } {
  // TODO: also run states.ts canTransition() guard so we never propose an illegal transition
  if (!policy.autoAcceptEnabled) return { decision: 'manual', reason: 'auto disabled' };
  if (req.amountSat > policy.maxAutoReleaseSat) return { decision: 'manual', reason: 'over auto cap' };
  if (floatSat - req.amountSat < policy.minFloatReserveSat) return { decision: 'manual', reason: 'below reserve' };
  return { decision: 'auto', reason: 'within policy' };
}

// ---------------------------------------------------------------------------
// Settlement — swap mainnet / mock / cashu without touching the rules engine
// ---------------------------------------------------------------------------
interface ReleaseResult { ok: boolean; paymentHash?: string; error?: string }

interface Settlement {
  readonly name: string;
  getBalanceSat(): Promise<number>;
  release(p: { swapId: string; invoice: string; amountSat: number }): Promise<ReleaseResult>;
  createTopUp(p: { amountSat: number; externalId: string }): Promise<{ invoice: string }>;
}

class MockSettlement implements Settlement {
  readonly name = 'mock';
  private balance = 500_000; // demo float you can drain to trigger alerts
  async getBalanceSat() { return this.balance; }
  async release(p: { swapId: string; amountSat: number }) {
    if (p.amountSat > this.balance) return { ok: false, error: 'insufficient float' };
    this.balance -= p.amountSat;
    return { ok: true, paymentHash: 'mock_' + p.swapId };
  }
  async createTopUp(p: { amountSat: number }) {
    this.balance += p.amountSat; // pretend the top-up landed instantly
    return { invoice: 'lnbc_mock_topup' };
  }
}

class PhoenixdSettlement implements Settlement {
  readonly name = 'phoenixd';
  private auth = 'Basic ' + Buffer.from(':' + PHOENIXD_PASSWORD).toString('base64');
  private async post(path: string, body: Record<string, string>) {
    const res = await fetch(PHOENIXD_URL + path, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
    return res.json();
  }
  async getBalanceSat() {
    const res = await fetch(PHOENIXD_URL + '/getbalance', { headers: { Authorization: this.auth } });
    const j = await res.json() as { balanceSat: number };
    return j.balanceSat;
  }
  async release(p: { swapId: string; invoice: string; amountSat: number }) {
    try {
      // TODO: if invoice is a lightning address, call /paylnaddress instead of /payinvoice
      const j = await this.post('/payinvoice', { invoice: p.invoice, amountSat: String(p.amountSat) }) as { paymentHash: string };
      return { ok: true, paymentHash: j.paymentHash };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  async createTopUp(p: { amountSat: number; externalId: string }) {
    const j = await this.post('/createinvoice', {
      amountSat: String(p.amountSat), description: 'agent float top-up', externalId: p.externalId,
    }) as { serialized: string };
    return { invoice: j.serialized };
  }
}

class CashuSettlement implements Settlement {
  readonly name = 'cashu';
  async getBalanceSat(): Promise<number> { throw new Error('cashu settlement not implemented'); }
  async release(): Promise<ReleaseResult> { throw new Error('cashu settlement not implemented'); }
  async createTopUp(): Promise<{ invoice: string }> { throw new Error('cashu settlement not implemented'); }
}

function getSettlement(): Settlement {
  switch (SETTLEMENT) {
    case 'phoenixd': return new PhoenixdSettlement();
    case 'cashu':    return new CashuSettlement();
    default:         return new MockSettlement();
  }
}
const settlement = getSettlement();

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
async function checkLowFloat(floatSat: number) {
  // TODO: dynamic threshold, e.g. alert when floatSat < 3 * avg swap size
  if (floatSat < policy.lowFloatThresholdSat) {
    const msg = `float low: ${floatSat} sat (threshold ${policy.lowFloatThresholdSat})`;
    log('ALERT', msg);
    addAlert.run('warning', msg, Date.now());
    // TODO: publish a Nostr DM (NIP-17 gift-wrap via gift-wrap.ts) to AGENT_PUBKEY
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleSwapRequest(req: SwapRequest) {
  const ts = Date.now();
  const floatSat = await settlement.getBalanceSat();
  const { decision, reason } = evaluatePolicy(req, floatSat);
  const status = decision === 'auto' ? 'accepted_auto' : 'manual_review';
  upsertSwap.run({ id: req.id, customer_pk: req.customerPk, amount_sat: req.amountSat, invoice: req.invoice, direction: 'fiat_to_btc', status, ts });
  log('swap request', req.id, req.amountSat + ' sat ->', decision, `(${reason})`);
  // NOTE: release does NOT happen here. It waits for fiat confirmation.
  // TODO: if auto, publish a swap-accept event (kind 7301) to RELAYS, signed with AGENT_NSEC
}

async function handleFiatConfirmed(swapId: string) {
  const swap = getSwap.get(swapId) as any;
  if (!swap) return { ok: false, error: 'unknown swap' };
  if (swap.status !== 'accepted_auto' && swap.status !== 'manual_review') {
    return { ok: false, error: `bad state: ${swap.status}` };
  }
  // defense in depth: re-check reserve before releasing real money
  const floatSat = await settlement.getBalanceSat();
  if (floatSat - swap.amount_sat < policy.minFloatReserveSat) {
    return { ok: false, error: 'release would breach reserve' };
  }
  const result = await settlement.release({ swapId, invoice: swap.invoice, amountSat: swap.amount_sat });
  if (!result.ok) {
    setStatus.run('release_failed', Date.now(), swapId);
    log('release FAILED', swapId, result.error);
    return result;
  }
  setStatus.run('completed', Date.now(), swapId);
  addLedger.run(swapId, -swap.amount_sat, 'release', Date.now());
  log('released', swap.amount_sat + ' sat for', swapId, 'hash', result.paymentHash);
  // TODO: publish a swap-completed event to RELAYS, signed with AGENT_NSEC
  await checkLowFloat(await settlement.getBalanceSat());
  return result;
}

function handlePaymentReceived(evt: { amountSat?: number; externalId?: string; paymentHash?: string }) {
  const tag = evt.externalId ?? '';
  if (tag.startsWith('topup')) {
    addLedger.run(null, evt.amountSat ?? 0, 'topup', Date.now());
    log('float top-up landed', evt.amountSat + ' sat');
    return;
  }
  // For btc_to_fiat (out of scope for the prototype) the customer pays the agent here.
  // TODO: correlate evt.externalId -> swapId and advance that swap's state.
  log('payment received', evt.amountSat + ' sat', 'externalId=' + tag);
}

// ---------------------------------------------------------------------------
// Subscription 1: Nostr relay -> swap requests
// ---------------------------------------------------------------------------
const pool = new SimplePool();
function startNostr() {
  const filter: Record<string, unknown> = { kinds: SWAP_REQUEST_KINDS, since: Math.floor(Date.now() / 1000) };
  if (AGENT_PUBKEY) filter['#p'] = [AGENT_PUBKEY]; // only requests addressed to this agent
  log('subscribing to relays', RELAYS.join(', '));
  pool.subscribeMany(RELAYS, [filter], {
    onevent(event) {
      try {
        // TODO: validate + parse with the Zod schema in kinds.ts instead of this stub
        const content = JSON.parse(event.content || '{}');
        handleSwapRequest({
          id: event.id,
          customerPk: event.pubkey,
          amountSat: Number(content.amountSat ?? 0),
          invoice: String(content.invoice ?? ''),
        });
      } catch (e) {
        log('bad swap-request event', event.id, String(e));
      }
    },
    oneose() { log('relay subscription live (EOSE)'); },
  });
}

// ---------------------------------------------------------------------------
// Subscription 2: phoenixd websocket -> incoming payments
// ---------------------------------------------------------------------------
function startPhoenixd() {
  if (SETTLEMENT !== 'phoenixd') { log('settlement=' + SETTLEMENT + ', skipping phoenixd websocket'); return; }
  const ws = new WebSocket(PHOENIXD_WS, {
    headers: { Authorization: 'Basic ' + Buffer.from(':' + PHOENIXD_PASSWORD).toString('base64') },
  });
  ws.on('open', () => log('phoenixd websocket connected'));
  ws.on('message', (data) => {
    try { handlePaymentReceived(JSON.parse(data.toString())); }
    catch (e) { log('bad phoenixd message', String(e)); }
  });
  ws.on('close', () => { log('phoenixd websocket closed, reconnecting in 3s'); setTimeout(startPhoenixd, 3000); });
  ws.on('error', (e) => log('phoenixd websocket error', String(e)));
}

// ---------------------------------------------------------------------------
// Control surface — the dashboard WRITES here; it READS the SQLite db directly
// ---------------------------------------------------------------------------
function startControlServer() {
  http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Content-Type', 'application/json');

    // POST /swaps/:id/confirm-fiat  -> agent attests M-Pesa received, triggers release
    const m = url.pathname.match(/^\/swaps\/([^/]+)\/confirm-fiat$/);
    if (req.method === 'POST' && m) {
      const out = await handleFiatConfirmed(m[1]);
      res.statusCode = out.ok ? 200 : 409;
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      const swaps = db.prepare('SELECT * FROM swaps ORDER BY updated_at DESC LIMIT 50').all();
      const floatSat = await settlement.getBalanceSat();
      return res.end(JSON.stringify({ settlement: settlement.name, floatSat, policy, swaps }));
    }
    if (req.method === 'POST' && url.pathname === '/policy') {
      let raw = ''; for await (const c of req) raw += c;
      policy = { ...policy, ...JSON.parse(raw || '{}') };
      return res.end(JSON.stringify(policy));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  }).listen(CONTROL_PORT, () => log('control server on :' + CONTROL_PORT));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('agent daemon starting — settlement=' + settlement.name);
  log('float at boot:', await settlement.getBalanceSat(), 'sat');
  startNostr();
  startPhoenixd();
  startControlServer();
  log('daemon breathing. waiting for swap requests + payments.');
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
process.on('SIGINT', () => { log('shutting down'); pool.close(RELAYS); db.close(); process.exit(0); });
