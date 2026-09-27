"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RelayStatus } from "@/components/RelayStatus";
import { SignerBadge, useSigner } from "@/components/SignerGate";
import { queryEvents } from "@/lib/pontmore/relay";
import { KIND_AGENT_DEFINITION } from "@/lib/pontmore/kinds";

export default function Home() {
  const { pubkey } = useSigner();

  // Warm the relay pool on load so RelayStatus reflects live connections.
  useEffect(() => {
    queryEvents([{ kinds: [KIND_AGENT_DEFINITION], limit: 1 }]).catch(() => {});
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <RelayStatus />
        {pubkey ? (
          <SignerBadge />
        ) : (
          <Link href="#connect" className="text-sm underline">
            sign in
          </Link>
        )}
      </header>

      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Pontmore Swap</h1>
        <p className="text-neutral-500">
          A Nostr-native coordination layer for Bitcoin ⇄ fiat swaps,
          implementing the PIP-02 swap state machine. Every public state change
          is a real Nostr event on public relays; sensitive payment details move
          privately through NIP-59 Gift Wrap.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-green-400/40 bg-green-50 p-3 text-sm dark:bg-green-950/20">
            <p className="font-medium text-green-700 dark:text-green-400">
              What&apos;s real
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-neutral-600 dark:text-neutral-400">
              <li>Live Nostr identities (NIP-07) and signatures</li>
              <li>7300/7301/7302/30362 events on public relays</li>
              <li>Append-only, matrix-validated state machine</li>
              <li>End-to-end-encrypted payment instructions (NIP-59)</li>
            </ul>
          </div>
          <div className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              What&apos;s role-play
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-neutral-600 dark:text-neutral-400">
              <li>No real money — “Funded”/“Released” are honor-system</li>
              <li>No Lightning invoices or escrow custody</li>
              <li>No disputes, reputation, or btc → fiat (v1)</li>
              <li>Publish agents/escrow at poc.pontmore.xyz, not here</li>
            </ul>
          </div>
        </div>
      </section>

      <nav className="flex flex-wrap gap-3">
        <Link
          href="/swap/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Send cross-border · get an AI-matched agent
        </Link>
        <Link
          href="/agents"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
        >
          Browse agents
        </Link>
        <Link
          href="/agent/inbox"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
        >
          Agent inbox
        </Link>
      </nav>

      <section
        id="connect"
        className="border-t border-neutral-200 pt-8 dark:border-neutral-800"
      >
        {pubkey ? (
          <p className="text-sm text-neutral-500">
            Signed in as{" "}
            <span className="font-mono">{pubkey.slice(0, 16)}…</span>
          </p>
        ) : (
          <ConnectInline />
        )}
      </section>
    </main>
  );
}

function ConnectInline() {
  const { connectNip07, error } = useSigner();
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={connectNip07}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        Connect NIP-07 extension
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-neutral-500">
        Pages that need an identity (new swap, inbox, swap room) show a full
        connect prompt with a dev-key option.
      </p>
    </div>
  );
}
