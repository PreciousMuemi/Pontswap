"use client";

// StateTimeline — vertical timeline of a swap's lifecycle. The first node is
// the implicit "requested" state established by the 7300; each subsequent node
// is a validated 7301 transition. An invalid step (one the matrix rejects) is
// visibly flagged.

import type { Event } from "nostr-tools";
import { parseTransition } from "@/lib/pontmore/swap";
import { isTerminal, type SwapState, type ActorRole } from "@/lib/pontmore/states";

type Step = { to: SwapState; role: ActorRole; event: Event };

function when(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString();
}

export function StateTimeline({
  requestEvent,
  steps,
  invalidIndex,
}: {
  requestEvent: Event | null;
  steps: Step[];
  invalidIndex: number | null;
}) {
  const nodes: {
    state: SwapState;
    role: ActorRole;
    reason: string;
    at: number;
    invalid: boolean;
  }[] = [];

  if (requestEvent) {
    nodes.push({
      state: "requested",
      role: "customer",
      reason: "Swap requested.",
      at: requestEvent.created_at,
      invalid: false,
    });
  }

  steps.forEach((s, i) => {
    const c = parseTransition(s.event);
    nodes.push({
      state: s.to,
      role: s.role,
      reason: c?.reason ?? "",
      at: s.event.created_at,
      invalid: invalidIndex !== null && i >= invalidIndex,
    });
  });

  return (
    <ol className="relative space-y-0 border-l border-neutral-200 dark:border-neutral-800">
      {nodes.map((n, i) => {
        const isCurrent = i === nodes.length - 1;
        return (
          <li key={i} className="ml-4 pb-5 pt-0">
            <span
              className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${
                n.invalid
                  ? "bg-red-500"
                  : isCurrent
                    ? isTerminal(n.state)
                      ? "bg-green-500"
                      : "bg-blue-500"
                    : "bg-neutral-400"
              }`}
              aria-hidden
            />
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{n.state}</span>
              <span className="text-xs text-neutral-500">by {n.role}</span>
              {n.invalid && (
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-400">
                  invalid transition
                </span>
              )}
              {isCurrent && !n.invalid && (
                <span className="text-xs text-blue-600 dark:text-blue-400">
                  current
                </span>
              )}
            </div>
            {n.reason && (
              <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
                {n.reason}
              </p>
            )}
            <p className="text-xs text-neutral-400">{when(n.at)}</p>
          </li>
        );
      })}
      {nodes.length === 0 && (
        <li className="ml-4 py-2 text-sm text-neutral-500">
          No events yet for this swap.
        </li>
      )}
    </ol>
  );
}
