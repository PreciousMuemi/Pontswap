"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Event } from "nostr-tools";
import {
  subscribeAgentInbox,
  appendTransition,
  parseSwapRequest,
  fetchSwapHistory,
  currentStateFromHistory,
} from "@/lib/pontmore/swap";
import {
  destinationAmountLabel,
  type SwapRequestContent,
} from "@/lib/pontmore/kinds";
import { canTransition, type SwapState } from "@/lib/pontmore/states";
import { shortNpub } from "@/lib/pontmore/nip19";
import { SignerGate, SignerBadge, useSigner } from "@/components/SignerGate";
import { RelayStatus } from "@/components/RelayStatus";
import { RolePlayBanner } from "@/components/swap/RolePlayBanner";

export default function InboxPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm underline">
          ← home
        </Link>
        <div className="flex items-center gap-4">
          <RelayStatus />
          <SignerBadge />
        </div>
      </div>
      <RolePlayBanner />
      <h1 className="text-2xl font-semibold">Agent inbox</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Incoming swap requests addressed to your identity, live.
      </p>
      <SignerGate>
        <Inbox />
      </SignerGate>
    </main>
  );
}

type Item = { event: Event; content: SwapRequestContent };

function Inbox() {
  const { pubkey } = useSigner();
  const [items, setItems] = useState<Map<string, Item>>(new Map());

  useEffect(() => {
    if (!pubkey) return;
    const unsub = subscribeAgentInbox(pubkey, (event) => {
      const content = parseSwapRequest(event);
      if (!content) return;
      setItems((prev) => {
        if (prev.has(event.id)) return prev;
        const next = new Map(prev);
        next.set(event.id, { event, content });
        return next;
      });
    });
    return unsub;
  }, [pubkey]);

  const list = [...items.values()].sort(
    (a, b) => b.event.created_at - a.event.created_at,
  );

  if (list.length === 0) {
    return (
      <p className="mt-6 text-sm text-neutral-500">
        Waiting for swap requests… they appear here in real time.
      </p>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {list.map((item) => (
        <RequestCard key={item.event.id} item={item} />
      ))}
    </div>
  );
}

function RequestCard({ item }: { item: Item }) {
  const router = useRouter();
  const { signer } = useSigner();
  const { event, content } = item;

  const [state, setState] = useState<SwapState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expired = content.expiry * 1000 < Date.now();

  // Derive whether this request is still actionable from its live chain.
  useEffect(() => {
    let active = true;
    fetchSwapHistory(content.swap_id)
      .then((events) => {
        if (active) setState(currentStateFromHistory(events).state);
      })
      .catch(() => active && setState("requested"));
    return () => {
      active = false;
    };
  }, [content.swap_id]);

  async function act(target: SwapState, navigate: boolean) {
    if (!signer) return;
    setError(null);
    setBusy(true);
    try {
      await appendTransition(signer, {
        swapId: content.swap_id,
        state: target,
        prevState: "requested",
        actorRole: "agent",
        reason:
          target === "accepted"
            ? "Agent accepted the swap request."
            : "Agent declined the swap request.",
        requestEventId: event.id,
      });
      if (navigate) router.push(`/swap/${content.swap_id}`);
      else setState(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transition failed.");
    } finally {
      setBusy(false);
    }
  }

  const pending = state === "requested" && !expired;
  const canAccept = canTransition("requested", "accepted", "agent");
  const canDecline = canTransition("requested", "canceled", "agent");

  return (
    <article className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm">
            From customer{" "}
            <span className="font-mono">{shortNpub(content.customer)}</span>
          </p>
          <p className="mt-1 text-lg font-semibold">
            {content.fiat.amount} {content.fiat.currency}
            <span className="text-neutral-400"> → </span>
            {content.bitcoin.amount_sats} sats
          </p>
          <p className="text-xs text-neutral-500">
            via {content.fiat.rail} · payout {content.bitcoin.payout}
          </p>
          {content.corridor && (
            <p className="text-xs text-neutral-500">
              cross-border {content.corridor.origin_country} →{" "}
              {content.corridor.destination_country} · recipient gets{" "}
              {destinationAmountLabel(content.corridor)} via{" "}
              {content.corridor.payout_method}
            </p>
          )}
        </div>
        <StatusBadge state={state} expired={expired} />
      </div>

      <p className="mt-2 break-all font-mono text-xs text-neutral-400">
        swap_id: {content.swap_id}
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex gap-2">
        {pending ? (
          <>
            <button
              type="button"
              disabled={busy || !canAccept}
              onClick={() => act("accepted", true)}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {busy ? "…" : "Accept"}
            </button>
            <button
              type="button"
              disabled={busy || !canDecline}
              onClick={() => act("canceled", false)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
            >
              Decline
            </button>
          </>
        ) : (
          <Link
            href={`/swap/${content.swap_id}`}
            className="text-sm underline"
          >
            Open swap room →
          </Link>
        )}
      </div>
    </article>
  );
}

function StatusBadge({
  state,
  expired,
}: {
  state: SwapState | "loading";
  expired: boolean;
}) {
  const label =
    state === "loading" ? "…" : expired && state === "requested" ? "expired" : state;
  return (
    <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
      {label}
    </span>
  );
}
