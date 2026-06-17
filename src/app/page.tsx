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
          A Nostr-native coordination layer for Bitcoin ⇄ fiat swaps. Every
          public state change is a real Nostr event; sensitive payment details
          move through NIP-59 Gift Wrap.
        </p>
        <p className="rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
          ROLE-PLAY — no real funds move.
        </p>
      </section>

      <nav className="flex flex-wrap gap-3">
        <Link
          href="/agents"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
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
