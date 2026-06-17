// lib/pontmore/relay.ts
//
// Thin wrapper around nostr-tools' SimplePool. This is the single seam through
// which every relay read/write in the app flows. The pool is a lazily created
// module singleton so all callers share connections.
//
// A dead relay must not block the others: querySync resolves on EOSE/timeout
// per relay, and publish/query use allSettled so one failing socket is ignored.

import { SimplePool } from "nostr-tools/pool";
import type { Event, Filter } from "nostr-tools";
import { DEFAULT_RELAYS } from "@/config/relays";

const RELAYS = [...DEFAULT_RELAYS];

/** Max time (ms) a one-shot query waits for relays before giving up. */
const QUERY_TIMEOUT_MS = 5000;

let pool: SimplePool | null = null;

export function getPool(): SimplePool {
  if (!pool) {
    pool = new SimplePool();
  }
  return pool;
}

/** The relay URLs this app is configured to talk to. */
export function getRelays(): string[] {
  return [...RELAYS];
}

/**
 * Publish a signed event to all configured relays. Resolves once every relay
 * has either accepted or rejected — a single failing relay never rejects the
 * whole call.
 */
export async function publishEvent(signedEvent: Event): Promise<void> {
  const results = await Promise.allSettled(
    getPool().publish(RELAYS, signedEvent),
  );
  const ok = results.some((r) => r.status === "fulfilled");
  if (!ok) {
    throw new Error("publish failed on all relays");
  }
}

/**
 * One-shot query across all relays for the given filters. Results are merged
 * and de-duplicated by event id. nostr-tools' querySync accepts a single
 * filter, so multiple filters are fanned out and merged here.
 */
export async function queryEvents(filters: Filter[]): Promise<Event[]> {
  const pool = getPool();
  const batches = await Promise.all(
    filters.map((filter) =>
      pool
        .querySync(RELAYS, filter, { maxWait: QUERY_TIMEOUT_MS })
        .catch(() => [] as Event[]),
    ),
  );
  const byId = new Map<string, Event>();
  for (const batch of batches) {
    for (const ev of batch) {
      byId.set(ev.id, ev);
    }
  }
  return [...byId.values()];
}

/**
 * Live subscription across all relays. Calls onEvent for each event matching
 * any of the filters. Returns an unsubscribe function that closes every
 * underlying subscription.
 */
export function subscribe(
  filters: Filter[],
  onEvent: (e: Event) => void,
): () => void {
  const pool = getPool();
  const closers = filters.map((filter) =>
    pool.subscribeMany(RELAYS, filter, { onevent: onEvent }),
  );
  return () => {
    for (const closer of closers) {
      closer.close();
    }
  };
}

/** Snapshot of which relays currently have an open connection. */
export function connectionStatus(): Map<string, boolean> {
  return getPool().listConnectionStatus();
}
