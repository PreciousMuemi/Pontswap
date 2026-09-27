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
  buildSnapshotContent,
  publishSnapshot,
} from "@/lib/pontmore/swap";
import {
  nextStatesFor,
  isTerminal,
  type SwapState,
  type ActorRole,
} from "@/lib/pontmore/states";
import { shortNpub } from "@/lib/pontmore/nip19";
import { destinationAmountLabel, satsLabel } from "@/lib/pontmore/kinds";
import { SignerGate, SignerBadge, useSigner } from "@/components/SignerGate";
import { RelayStatus } from "@/components/RelayStatus";
import { StateTimeline } from "@/components/swap/StateTimeline";
import { ActionButton } from "@/components/swap/ActionButton";
import { GiftWrapPanel } from "@/components/swap/GiftWrapPanel";
import { EvidenceForm } from "@/components/swap/EvidenceForm";
import { RolePlayBanner } from "@/components/swap/RolePlayBanner";
import type { SwapRequestContent } from "@/lib/pontmore/kinds";

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

      <RolePlayBanner />

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
      <Link
        href={`/swap/${swapId}/explorer`}
        className="text-xs text-neutral-500 underline"
      >
        public explorer →
      </Link>

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
          {request.corridor ? (
            <>
              <Detail
                label="Corridor"
                value={`${request.corridor.origin_country} → ${request.corridor.destination_country}`}
              />
              <Detail
                label="Recipient gets"
                value={`${destinationAmountLabel(request.corridor)} (${request.corridor.payout_method})`}
              />
              <Detail
                label="Settlement"
                value={`${request.corridor.settlement_asset} · ${satsLabel(request.bitcoin)} (${request.bitcoin.payout})`}
              />
            </>
          ) : (
            <Detail
              label="You receive"
              value={`${satsLabel(request.bitcoin)} (${request.bitcoin.payout})`}
            />
          )}
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
        <div className="mt-8">
          <SignerGate>
            <ParticipantArea
              swapId={swapId}
              currentState={view.state}
              requestEventId={view.requestEvent.id}
              request={request}
              events={eventList}
            />
          </SignerGate>
        </div>
      )}
    </main>
  );
}

function ParticipantArea({
  swapId,
  currentState,
  requestEventId,
  request,
  events,
}: {
  swapId: string;
  currentState: SwapState;
  requestEventId: string;
  request: SwapRequestContent;
  events: Event[];
}) {
  const { pubkey } = useSigner();
  const myRole: ActorRole | null =
    pubkey === request.customer
      ? "customer"
      : pubkey === request.agent
        ? "agent"
        : null;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Private messages</h2>
        <GiftWrapPanel
          swapId={swapId}
          myRole={myRole}
          customerHex={request.customer}
          agentHex={request.agent}
          defaultRail={request.fiat.rail}
          defaultAmount={request.fiat.amount}
          defaultCurrency={request.fiat.currency}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Actions</h2>
        <Actions
          swapId={swapId}
          currentState={currentState}
          requestEventId={requestEventId}
          myRole={myRole}
          request={request}
          events={events}
        />
      </section>
    </div>
  );
}

function Actions({
  swapId,
  currentState,
  requestEventId,
  myRole,
  request,
  events,
}: {
  swapId: string;
  currentState: SwapState;
  requestEventId: string;
  myRole: ActorRole | null;
  request: SwapRequestContent;
  events: Event[];
}) {
  const { signer, nip44Supported } = useSigner();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = myRole ? nextStatesFor(currentState, myRole) : [];

  // The customer's funded → fiat_sent move goes through the evidence form.
  const useEvidenceForm = myRole === "customer" && currentState === "funded";

  async function act(to: SwapState) {
    if (!signer || !myRole) return;
    setError(null);
    setBusy(true);
    try {
      if (to === "released" && myRole === "agent") {
        await finalizeRelease();
      } else {
        await appendTransition(signer, {
          swapId,
          state: to,
          prevState: currentState,
          actorRole: myRole,
          reason: REASONS[to] ?? `Moved to ${to}.`,
          requestEventId,
        });
      }
      // Live subscription will fold the new event(s) into the timeline.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transition failed.");
    } finally {
      setBusy(false);
    }
  }

  // Release is the terminal happy-path action: release the BTC (role-play),
  // acknowledge completion, and immediately publish the 30362 snapshot built
  // from the now-complete chain.
  async function finalizeRelease() {
    if (!signer) return;
    const releasedEv = await appendTransition(signer, {
      swapId,
      state: "released",
      prevState: currentState,
      actorRole: "agent",
      reason: REASONS.released!,
      requestEventId,
    });
    const completedEv = await appendTransition(signer, {
      swapId,
      state: "completed",
      prevState: "released",
      actorRole: "agent",
      reason: REASONS.completed!,
      requestEventId,
    });
    const snapshot = buildSnapshotContent(
      request,
      [...events, releasedEv, completedEv],
      "completed",
    );
    await publishSnapshot(signer, snapshot);
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

      {useEvidenceForm && (
        <EvidenceForm
          swapId={swapId}
          requestEventId={requestEventId}
          agentHex={request.agent}
          nip44Supported={nip44Supported}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {targets.length === 0 && (
          <p className="text-sm text-neutral-500">
            Nothing for you to do right now — waiting on the other party.
          </p>
        )}
        {targets
          .filter((to) => !(useEvidenceForm && to === "fiat_sent"))
          .map((to) => (
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
