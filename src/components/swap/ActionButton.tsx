"use client";

// ActionButton — a single state-transition action, gated by canTransition().
// If the current actor cannot legally move from `from` to `to`, this renders
// nothing. The matrix is the only authority on what is allowed; this is the
// last line of defense in case a caller forgets to filter.

import { canTransition, type SwapState, type ActorRole } from "@/lib/pontmore/states";

const LABELS: Partial<Record<SwapState, string>> = {
  accepted: "Accept",
  funded: "Mark escrow funded",
  fiat_sent: "I sent the fiat",
  fiat_confirmed: "Confirm fiat received",
  released: "Release BTC",
  completed: "Mark completed",
  canceled: "Cancel",
  refunded: "Refund",
  expired: "Mark expired",
  disputed: "Open dispute",
};

const DESTRUCTIVE: ReadonlySet<SwapState> = new Set<SwapState>([
  "canceled",
  "refunded",
  "expired",
  "disputed",
]);

export function ActionButton({
  from,
  to,
  role,
  busy,
  onAct,
}: {
  from: SwapState;
  to: SwapState;
  role: ActorRole;
  busy?: boolean;
  onAct: (to: SwapState) => void;
}) {
  if (!canTransition(from, to, role)) return null;

  const destructive = DESTRUCTIVE.has(to);
  const handle = () => {
    if (destructive && !window.confirm(`Move this swap to "${to}"?`)) return;
    onAct(to);
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={handle}
      className={
        destructive
          ? "rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
          : "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      }
    >
      {LABELS[to] ?? to}
    </button>
  );
}
