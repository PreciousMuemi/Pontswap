"use client";

// Public swap explorer — read-only, no auth. Renders the full public event
// chain for any swap_id, validates the 7301 chain via replayTransitions (inside
// currentStateFromHistory), and visibly flags any invalid step.
//
// Note: gift-wrapped messages (kind 1059) are addressed by ["p", recipient],
// not ["d", swap_id], so this view structurally cannot fetch them. Private
// payment details never appear here — by construction.

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { Event } from "nostr-tools";
import {
  fetchSwapHistory,
  subscribeSwap,
  parseSwapRequest,
  parseTransition,
  parseEvidence,
  currentStateFromHistory,
} from "@/lib/pontmore/swap";
import {
  KIND_SWAP_REQUEST,
  KIND_TRANSITION,
  KIND_EVIDENCE,
  KIND_NOTE,
  KIND_SNAPSHOT,
  SnapshotContent,
  destinationAmountLabel,
} from "@/lib/pontmore/kinds";
import { isTerminal } from "@/lib/pontmore/states";
import { shortNpub } from "@/lib/pontmore/nip19";
import { StateTimeline } from "@/components/swap/StateTimeline";
import { RolePlayBanner } from "@/components/swap/RolePlayBanner";
import { RelayStatus } from "@/components/RelayStatus";

export default function ExplorerPage() {
  const params = useParams<{ id: string }>();
  const swapId = params.id;
  const router = useRouter();

  const [events, setEvents] = useState<Map<string, Event>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [lookup, setLookup] = useState("");

  useEffect(() => {
    if (!swapId) return;
    let active = true;
    const add = (incoming: Event[]) =>
      setEvents((prev) => {
        const next = new Map(prev);
        for (const e of incoming) next.set(e.id, e);
        return next;
      });

    setEvents(new Map());
    setLoaded(false);
    fetchSwapHistory(swapId)
      .then((h) => active && (add(h), setLoaded(true)))
      .catch(() => active && setLoaded(true));
    const unsub = subscribeSwap(swapId, (e) => active && add([e]));
    return () => {
      active = false;
      unsub();
    };
  }, [swapId]);

  const eventList = useMemo(() => [...events.values()], [events]);
  const view = useMemo(() => currentStateFromHistory(eventList), [eventList]);
  const request = view.requestEvent
    ? parseSwapRequest(view.requestEvent)
    : null;

  const chronological = useMemo(
    () => [...eventList].sort((a, b) => a.created_at - b.created_at),
    [eventList],
  );

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <Link href={`/swap/${swapId}`} className="text-sm underline">
          ← swap room
        </Link>
        <RelayStatus />
      </div>

      <RolePlayBanner />

      <h1 className="text-2xl font-semibold">Swap explorer</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Public, read-only view of every on-relay event for this swap.
      </p>
      <p className="mt-2 break-all font-mono text-xs text-neutral-400">
        {swapId}
      </p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (lookup.trim())
            router.push(`/swap/${lookup.trim()}/explorer`);
        }}
      >
        <input
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          placeholder="look up another swap_id"
          className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
        >
          Go
        </button>
      </form>

      {!loaded && (
        <p className="mt-6 text-sm text-neutral-500">Loading events…</p>
      )}

      {loaded && eventList.length === 0 && (
        <p className="mt-6 text-sm text-neutral-500">
          No public events found for this swap_id.
        </p>
      )}

      {eventList.length > 0 && (
        <>
          <div
            className={`mt-6 rounded-md px-3 py-2 text-sm ${
              view.ok
                ? isTerminal(view.state)
                  ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                  : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
            }`}
          >
            {view.ok ? (
              <>
                Chain is valid. Current state:{" "}
                <span className="font-medium">{view.state}</span>.
              </>
            ) : (
              <>
                ⚠ Invalid transition chain — first illegal step at index{" "}
                {view.invalidIndex}. Derived state halts at{" "}
                <span className="font-medium">{view.state}</span>.
              </>
            )}
          </div>

          {request && (
            <section className="mt-6 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <p className="font-medium">Swap request</p>
              <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                {request.fiat.amount} {request.fiat.currency} →{" "}
                {request.bitcoin.amount_sats} sats · {request.swap_type}
              </p>
              {request.corridor && (
                <p className="text-neutral-600 dark:text-neutral-400">
                  {request.corridor.origin_country} →{" "}
                  {request.corridor.destination_country} · payout{" "}
                  {destinationAmountLabel(request.corridor)} via{" "}
                  {request.corridor.payout_method}
                </p>
              )}
              <p className="text-xs text-neutral-500">
                customer {shortNpub(request.customer)} · agent{" "}
                {shortNpub(request.agent)}
              </p>
            </section>
          )}

          {view.requestEvent && (
            <>
              <h2 className="mt-8 mb-3 text-lg font-semibold">
                Validated timeline
              </h2>
              <StateTimeline
                requestEvent={view.requestEvent}
                steps={view.steps}
                invalidIndex={view.invalidIndex}
              />
            </>
          )}

          <h2 className="mt-8 mb-3 text-lg font-semibold">
            All events ({chronological.length})
          </h2>
          <ul className="space-y-2">
            {chronological.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function kindLabel(event: Event): { label: string; detail: string } {
  switch (event.kind) {
    case KIND_SWAP_REQUEST: {
      const c = parseSwapRequest(event);
      return {
        label: "7300 request",
        detail: c
          ? `${c.fiat.amount} ${c.fiat.currency} → ${c.bitcoin.amount_sats} sats`
          : "unparseable",
      };
    }
    case KIND_TRANSITION: {
      const c = parseTransition(event);
      return {
        label: "7301 transition",
        detail: c
          ? `${c.prev_state} → ${c.state} (by ${c.actor_role})`
          : "unparseable",
      };
    }
    case KIND_EVIDENCE: {
      const c = parseEvidence(event);
      return {
        label: "7302 evidence",
        detail: c
          ? `${c.type}${c.ref ? ` · ref ${c.ref}` : ""}${c.ref_hash ? " · +hash" : ""}`
          : "unparseable",
      };
    }
    case KIND_NOTE:
      return { label: "7304 note", detail: "" };
    case KIND_SNAPSHOT: {
      const parsed = SnapshotContent.safeParse(
        (() => {
          try {
            return JSON.parse(event.content);
          } catch {
            return null;
          }
        })(),
      );
      return {
        label: "30362 snapshot",
        detail: parsed.success
          ? `final_state ${parsed.data.final_state}`
          : "unparseable",
      };
    }
    default:
      return { label: `kind ${event.kind}`, detail: "" };
  }
}

function EventRow({ event }: { event: Event }) {
  const { label, detail } = kindLabel(event);
  return (
    <li className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-neutral-400">
          {new Date(event.created_at * 1000).toLocaleString()}
        </span>
      </div>
      {detail && (
        <p className="mt-0.5 text-neutral-600 dark:text-neutral-400">
          {detail}
        </p>
      )}
      <p className="mt-1 break-all font-mono text-xs text-neutral-400">
        by {shortNpub(event.pubkey)} · id {event.id.slice(0, 16)}…
      </p>
    </li>
  );
}
