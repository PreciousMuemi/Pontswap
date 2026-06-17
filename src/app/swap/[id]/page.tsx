"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Event } from "nostr-tools";
import {
  fetchSwapHistory,
  subscribeSwap,
  parseSwapRequest,
  appendTransition,
  currentStateFromHistory,
} from "@/lib/pontmore/swap";
import {
  nextStatesFor,
  isTerminal,
  type SwapState,
  type ActorRole,
} from "@/lib/pontmore/states";
import { shortNpub } from "@/lib/pontmore/nip19";
import { SignerGate, SignerBadge, useSigner } from "@/components/SignerGate";
import { RelayStatus } from "@/components/RelayStatus";
import { StateTimeline } from "@/components/swap/StateTimeline";
import { ActionButton } from "@/components/swap/ActionButton";

const REASONS: Partial<Record<SwapState, string>> = {
  funded: "Escrow funded (role-play).",
  fiat_sent: "Customer marked the fiat as sent.",
  fiat_confirmed: "Agent confirmed fiat receipt.",
  released: "Agent released the BTC (role-play).",
  completed: "Swap completed.",
  canceled: "Swap canceled.",
  refunded: "Escrow refunded.",
  expired: "Swap expired.",
  disputed: "Dispute opened.",
};

export default function SwapRoomPage() {
  const params = useParams<{ id: string }>();
  const swapId = params.id;

  const [events, setEvents] = useState<Map<string, Event>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!swapId) return;
    let active = true;

    const add = (incoming: Event[]) =>
      setEvents((prev) => {
        const next = new Map(prev);
        for (const e of incoming) next.set(e.id, e);
        return next;
      });

    fetchSwapHistory(swapId)
      .then((history) => {
        if (!active) return;
        add(history);
        setLoaded(true);
      })
      .catch(() => active && setLoaded(true));

    const unsub = subscribeSwap(swapId, (e) => active && add([e]));
    return () => {
      active = false;
      unsub();
    };
  }, [swapId]);

  const eventList = useMemo(() => [...events.values()], [events]);
  const view = useMemo(
    () => currentStateFromHistory(eventList),
    [eventList],
  );
  const request = view.requestEvent
    ? parseSwapRequest(view.requestEvent)
    : null;

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

      <p className="mb-6 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
        ROLE-PLAY — no real funds move.
      </p>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Swap room</h1>
        <span
          className={`rounded px-2 py-0.5 text-sm ${
            view.ok
              ? isTerminal(view.state)
                ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
              : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
          }`}
        >
          {view.state}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-neutral-400">
        {swapId}
      </p>

      {!loaded && (
        <p className="mt-6 text-sm text-neutral-500">Loading swap…</p>
      )}

      {loaded && !view.requestEvent && (
        <p className="mt-6 text-sm text-neutral-500">
          No swap request (7300) found for this id on the relays.
        </p>
      )}

      {request && (
        <section className="mt-6 grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <Detail label="Customer" value={shortNpub(request.customer)} mono />
          <Detail label="Agent" value={shortNpub(request.agent)} mono />
          <Detail
            label="You pay"
            value={`${request.fiat.amount} ${request.fiat.currency} (${request.fiat.rail})`}
          />
          <Detail
            label="You receive"
            value={`${request.bitcoin.amount_sats} sats (${request.bitcoin.payout})`}
          />
          <Detail
            label="Expiry"
            value={new Date(request.expiry * 1000).toLocaleString()}
          />
          <Detail label="Escrow" value={request.escrow_reference} mono />
        </section>
      )}

      {view.requestEvent && (
        <>
          <h2 className="mt-8 mb-3 text-lg font-semibold">Timeline</h2>
          <StateTimeline
            requestEvent={view.requestEvent}
            steps={view.steps}
            invalidIndex={view.invalidIndex}
          />
        </>
      )}

      {request && view.requestEvent && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Actions</h2>
          <SignerGate>
            <Actions
              swapId={swapId}
              currentState={view.state}
              requestEventId={view.requestEvent.id}
              customer={request.customer}
              agent={request.agent}
            />
          </SignerGate>
        </section>
      )}
    </main>
  );
}

function Actions({
  swapId,
  currentState,
  requestEventId,
  customer,
  agent,
}: {
  swapId: string;
  currentState: SwapState;
  requestEventId: string;
  customer: string;
  agent: string;
}) {
  const { signer, pubkey } = useSigner();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const myRole: ActorRole | null =
    pubkey === customer ? "customer" : pubkey === agent ? "agent" : null;

  const targets = myRole ? nextStatesFor(currentState, myRole) : [];

  async function act(to: SwapState) {
    if (!signer || !myRole) return;
    setError(null);
    setBusy(true);
    try {
      await appendTransition(signer, {
        swapId,
        state: to,
        prevState: currentState,
        actorRole: myRole,
        reason: REASONS[to] ?? `Moved to ${to}.`,
        requestEventId,
      });
      // Live subscription will fold the new 7301 into the timeline.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transition failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!myRole) {
    return (
      <p className="text-sm text-neutral-500">
        You are signed in but not a participant in this swap — observing only.
      </p>
    );
  }

  if (isTerminal(currentState)) {
    return (
      <p className="text-sm text-neutral-500">
        This swap is in a terminal state ({currentState}). No further actions.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        You are the <span className="font-medium">{myRole}</span>. Only legal
        moves are shown.
      </p>
      <div className="flex flex-wrap gap-2">
        {targets.length === 0 && (
          <p className="text-sm text-neutral-500">
            Nothing for you to do right now — waiting on the other party.
          </p>
        )}
        {targets.map((to) => (
          <ActionButton
            key={to}
            from={currentState}
            to={to}
            role={myRole}
            busy={busy}
            onAct={act}
          />
        ))}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={mono ? "break-all font-mono text-xs" : ""}>{value}</p>
    </div>
  );
}
