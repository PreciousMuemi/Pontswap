"use client";

// GiftWrapPanel — private, end-to-end-encrypted messages for one swap.
//
// The agent composes payment instructions and gift-wraps them to the customer.
// Both parties subscribe to their own inbound kind-1059 wraps, decrypt each,
// and keep only those whose inner swap_id matches this swap. Payment details
// never touch a public event.

import { useEffect, useMemo, useState } from "react";
import type { Event } from "nostr-tools";
import {
  subscribeGiftWraps,
  unwrapGiftWrap,
  sendGiftWrap,
} from "@/lib/pontmore/gift-wrap";
import {
  PaymentInstructionsContent,
  type PaymentInstructionsContent as Payment,
} from "@/lib/pontmore/kinds";
import type { ActorRole } from "@/lib/pontmore/states";
import { shortNpub } from "@/lib/pontmore/nip19";
import { useSigner } from "@/components/SignerGate";

type InboundMsg = {
  wrapId: string;
  senderHex: string;
  createdAt: number;
  payment: Payment | null;
  raw: unknown;
};

export function GiftWrapPanel({
  swapId,
  myRole,
  customerHex,
  agentHex,
  defaultRail,
  defaultAmount,
  defaultCurrency,
}: {
  swapId: string;
  myRole: ActorRole | null;
  customerHex: string;
  agentHex: string;
  defaultRail?: string;
  defaultAmount?: string;
  defaultCurrency?: string;
}) {
  const { signer, pubkey, nip44Supported } = useSigner();
  const [inbound, setInbound] = useState<Map<string, InboundMsg>>(new Map());

  useEffect(() => {
    if (!signer || !pubkey) return;
    const seen = new Set<string>();
    const unsub = subscribeGiftWraps(pubkey, async (wrap: Event) => {
      if (seen.has(wrap.id)) return;
      seen.add(wrap.id);
      const msg = await unwrapGiftWrap(signer, wrap);
      if (!msg) return;
      const payment = PaymentInstructionsContent.safeParse(msg.payload);
      const innerSwapId =
        payment.success
          ? payment.data.swap_id
          : (msg.payload as { swap_id?: string })?.swap_id;
      if (innerSwapId !== swapId) return; // belongs to a different swap
      setInbound((prev) => {
        const next = new Map(prev);
        next.set(wrap.id, {
          wrapId: wrap.id,
          senderHex: msg.senderHex,
          createdAt: msg.createdAt,
          payment: payment.success ? payment.data : null,
          raw: msg.payload,
        });
        return next;
      });
    });
    return unsub;
  }, [signer, pubkey, swapId]);

  const messages = useMemo(
    () => [...inbound.values()].sort((a, b) => a.createdAt - b.createdAt),
    [inbound],
  );

  if (!nip44Supported) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        Your signer does not support NIP-44 encryption, so private gift-wrapped
        messages are unavailable. Try Alby, or use the dev key.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {messages.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No private messages yet.
          {myRole === "customer"
            ? " The agent will send payment instructions here."
            : ""}
        </p>
      ) : (
        <ul className="space-y-3">
          {messages.map((m) => (
            <li
              key={m.wrapId}
              className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <p className="text-xs text-neutral-500">
                from {shortNpub(m.senderHex)} ·{" "}
                {new Date(m.createdAt * 1000).toLocaleString()}
              </p>
              {m.payment ? (
                <PaymentView p={m.payment} />
              ) : (
                <pre className="mt-1 overflow-x-auto text-xs">
                  {JSON.stringify(m.raw, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {myRole === "agent" && (
        <ComposePayment
          swapId={swapId}
          customerHex={customerHex}
          defaultRail={defaultRail}
          defaultAmount={defaultAmount}
          defaultCurrency={defaultCurrency}
        />
      )}
      {myRole === "agent" && (
        <p className="text-xs text-neutral-400">
          Note: instructions are encrypted to the customer ({shortNpub(
            customerHex,
          )}
          ); you cannot read them back from the relay after sending.
        </p>
      )}
      {agentHex && myRole === "customer" && null}
    </div>
  );
}

function PaymentView({ p }: { p: Payment }) {
  return (
    <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
      <Row k="Rail" v={p.rail} />
      <Row k="Pay to" v={p.payee} />
      {p.account && <Row k="Account" v={p.account} />}
      <Row k="Amount" v={`${p.amount} ${p.currency}`} />
      {p.reference && <Row k="Reference" v={p.reference} />}
      {p.note && <Row k="Note" v={p.note} />}
    </dl>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-neutral-500">{k}</dt>
      <dd className="col-span-2 font-medium">{v}</dd>
    </>
  );
}

function ComposePayment({
  swapId,
  customerHex,
  defaultRail,
  defaultAmount,
  defaultCurrency,
}: {
  swapId: string;
  customerHex: string;
  defaultRail?: string;
  defaultAmount?: string;
  defaultCurrency?: string;
}) {
  const { signer } = useSigner();
  const [rail, setRail] = useState(defaultRail ?? "mpesa");
  const [payee, setPayee] = useState("");
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState(defaultAmount ?? "");
  const [currency, setCurrency] = useState(defaultCurrency ?? "KES");
  const [reference, setReference] = useState(`PONT-${swapId.slice(0, 8)}`);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signer) return;
    const payload = {
      type: "payment_instructions" as const,
      swap_id: swapId,
      rail: rail.trim(),
      payee: payee.trim(),
      ...(account.trim() ? { account: account.trim() } : {}),
      amount: amount.trim(),
      currency: currency.trim(),
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const parsed = PaymentInstructionsContent.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid instructions.");
      return;
    }
    setBusy(true);
    try {
      await sendGiftWrap(signer, customerHex, parsed.data);
      setSentAt(Date.now());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to send gift wrap.",
      );
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-900";

  return (
    <form
      onSubmit={send}
      className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <p className="text-sm font-medium">Send payment instructions (private)</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-neutral-500">
          Rail
          <input value={rail} onChange={(e) => setRail(e.target.value)} className={input} />
        </label>
        <label className="text-xs text-neutral-500">
          Pay to (Till / Paybill)
          <input value={payee} onChange={(e) => setPayee(e.target.value)} className={input} placeholder="123456" />
        </label>
        <label className="text-xs text-neutral-500">
          Account (optional)
          <input value={account} onChange={(e) => setAccount(e.target.value)} className={input} />
        </label>
        <label className="text-xs text-neutral-500">
          Reference
          <input value={reference} onChange={(e) => setReference(e.target.value)} className={input} />
        </label>
        <label className="text-xs text-neutral-500">
          Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className={input} placeholder="5000" />
        </label>
        <label className="text-xs text-neutral-500">
          Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} className={input} />
        </label>
      </div>
      <label className="block text-xs text-neutral-500">
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} className={input} />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {sentAt && (
        <p className="text-sm text-green-600">
          Sent at {new Date(sentAt).toLocaleTimeString()} (gift-wrapped).
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? "Sending…" : "Gift-wrap to customer"}
      </button>
    </form>
  );
}
