"use client";

// EvidenceForm — the customer's "I sent the fiat" step.
//
// Posts a public kind 7302 carrying the M-Pesa transaction code as `ref`. If a
// screenshot is attached, only its SHA-256 hash travels — and it goes PRIVATELY
// via gift wrap to the agent as `ref_hash`, never in the public event. On
// success it appends the funded → fiat_sent transition.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postEvidence, appendTransition } from "@/lib/pontmore/swap";
import { sendGiftWrap } from "@/lib/pontmore/gift-wrap";
import { useSigner } from "@/components/SignerGate";

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function EvidenceForm({
  swapId,
  requestEventId,
  agentHex,
  nip44Supported,
}: {
  swapId: string;
  requestEventId: string;
  agentHex: string;
  nip44Supported: boolean;
}) {
  const { signer } = useSigner();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signer) return;
    if (!code.trim()) {
      setError("Enter the M-Pesa transaction code.");
      return;
    }
    setBusy(true);
    try {
      // Private artifact: hash the screenshot and gift-wrap the hash to the
      // agent. The screenshot itself never leaves the browser.
      if (file) {
        if (!nip44Supported) {
          setError(
            "A screenshot needs NIP-44 to send privately. Remove it or use a NIP-44 signer.",
          );
          setBusy(false);
          return;
        }
        const refHash = await sha256Hex(await file.arrayBuffer());
        await sendGiftWrap(signer, agentHex, {
          type: "evidence",
          swap_id: swapId,
          ref_hash: refHash,
          note: note.trim() || undefined,
        });
      }

      await postEvidence(signer, {
        swapId,
        type: "fiat_transfer_reference",
        ref: code.trim(),
        note: note.trim() || undefined,
        requestEventId,
      });

      await appendTransition(signer, {
        swapId,
        state: "fiat_sent",
        prevState: "funded",
        actorRole: "customer",
        reason: `Fiat sent; M-Pesa ref ${code.trim()}.`,
        requestEventId,
      });

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post evidence.");
      setBusy(false);
    }
  }

  const input =
    "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-900";

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <p className="text-sm font-medium">I sent the fiat</p>
      <label className="block text-xs text-neutral-500">
        M-Pesa transaction code (public evidence)
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. QGR7XK2P9D"
          className={input}
        />
      </label>
      <label className="block text-xs text-neutral-500">
        Note (optional, public)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={input}
        />
      </label>
      <label className="block text-xs text-neutral-500">
        Screenshot (optional — only its hash is sent, privately)
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block text-xs"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? "Posting…" : "Post evidence & mark fiat sent"}
      </button>
    </form>
  );
}
