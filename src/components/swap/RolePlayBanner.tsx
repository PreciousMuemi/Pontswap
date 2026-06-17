// RolePlayBanner — a persistent reminder that this app moves no real money.
// Required on every swap/ and agent/ page. "Funded" and "Released" are
// honor-system buttons; there are no Lightning invoices and no escrow custody.

export function RolePlayBanner() {
  return (
    <p
      role="note"
      className="mb-6 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
    >
      <span className="font-semibold">ROLE-PLAY</span> — no real funds move.
      “Funded” and “Released” are honor-system buttons; no Lightning invoice or
      escrow custody exists.
    </p>
  );
}
