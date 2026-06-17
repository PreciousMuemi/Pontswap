"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  fetchAgent,
  fetchEscrowDescriptor,
  type AgentDefinition,
  type EscrowDescriptor,
} from "@/lib/pontmore/discovery";
import { publishSwapRequest } from "@/lib/pontmore/swap";
import { tryNpubToHex, shortNpub } from "@/lib/pontmore/nip19";
import { SignerGate, useSigner } from "@/components/SignerGate";
import { RelayStatus } from "@/components/RelayStatus";
import { RolePlayBanner } from "@/components/swap/RolePlayBanner";

export default function NewSwapPage() {
  return (
    <Suspense fallback={<Shell>Loading…</Shell>}>
      <NewSwapInner />
    </Suspense>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/agents" className="text-sm underline">
          ← agents
        </Link>
        <RelayStatus />
      </div>
      <RolePlayBanner />
      {children}
    </main>
  );
}

const FIAT_AMOUNT_RE = /^\d+(\.\d+)?$/;
const SATS_RE = /^\d+$/;

function NewSwapInner() {
  const params = useSearchParams();
  const agentParam = params.get("agent") ?? "";
  const agentHex = useMemo(() => tryNpubToHex(agentParam), [agentParam]);

  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [escrow, setEscrow] = useState<EscrowDescriptor | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "notfound">(
    "loading",
  );

  useEffect(() => {
    if (!agentHex) {
      setLoad("notfound");
      return;
    }
    let active = true;
    setLoad("loading");
    fetchAgent(agentHex)
      .then(async (a) => {
        if (!active) return;
        if (!a) {
          setLoad("notfound");
          return;
        }
        setAgent(a);
        setLoad("ready");
        if (a.escrowReference) {
          const e = await fetchEscrowDescriptor(a.escrowReference);
          if (active) setEscrow(e);
        }
      })
      .catch(() => active && setLoad("notfound"));
    return () => {
      active = false;
    };
  }, [agentHex]);

  if (load === "loading") return <Shell>Loading agent…</Shell>;
  if (load === "notfound" || !agent) {
    return (
      <Shell>
        <p className="text-sm text-red-600">
          {agentParam
            ? "Could not find that agent on the relays."
            : "No agent specified. Pick one from the agents list."}
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Start a swap</h1>
      <div className="mt-2 text-sm text-neutral-500">
        with <span className="font-medium">{agent.content.name}</span>{" "}
        <span className="font-mono">{shortNpub(agent.pubkey)}</span>
      </div>
      <SignerGate>
        <SwapForm agent={agent} escrow={escrow} />
      </SignerGate>
    </Shell>
  );
}

function SwapForm({
  agent,
  escrow,
}: {
  agent: AgentDefinition;
  escrow: EscrowDescriptor | null;
}) {
  const router = useRouter();
  const { signer, pubkey } = useSigner();
  const caps = agent.content.capabilities;

  const [fiatCurrency, setFiatCurrency] = useState(
    caps?.fiat_currencies?.[0] ?? "KES",
  );
  const [fiatAmount, setFiatAmount] = useState("");
  const [fiatRail, setFiatRail] = useState(
    caps?.payment_channels?.[0] ?? "mpesa",
  );
  const [sats, setSats] = useState("");
  const [payout, setPayout] = useState(
    caps?.settlement_networks?.[0] ?? "lightning",
  );

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const noEscrow = !agent.escrowReference;
  const cannotSubmitToSelf = pubkey === agent.pubkey;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!signer) {
      setError("Connect an identity first.");
      return;
    }
    if (noEscrow) {
      setError("This agent has no escrow descriptor — cannot start a swap.");
      return;
    }
    if (cannotSubmitToSelf) {
      setError("You cannot open a swap with your own agent identity.");
      return;
    }
    if (!FIAT_AMOUNT_RE.test(fiatAmount)) {
      setError("Fiat amount must be a number, e.g. 5000.");
      return;
    }
    if (!SATS_RE.test(sats)) {
      setError("Bitcoin amount must be a whole number of sats.");
      return;
    }
    if (fiatCurrency.trim().length < 3) {
      setError("Currency code looks too short.");
      return;
    }

    setSubmitting(true);
    try {
      const { swapId } = await publishSwapRequest(signer, {
        agentPubkey: agent.pubkey,
        escrowReference: agent.escrowReference!,
        fiat: {
          currency: fiatCurrency.trim(),
          amount: fiatAmount.trim(),
          rail: fiatRail.trim(),
        },
        bitcoin: { amount_sats: sats.trim(), payout: payout.trim() },
      });
      router.push(`/swap/${swapId}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to publish swap request.",
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-5">
      <p className="text-xs text-neutral-500">
        Direction: <span className="font-medium">fiat → BTC</span>. v1 only
        supports fiat → BTC.
      </p>

      <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-sm font-medium">You pay (fiat)</legend>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Currency">
            <input
              value={fiatCurrency}
              onChange={(e) => setFiatCurrency(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Amount" className="col-span-2">
            <input
              value={fiatAmount}
              onChange={(e) => setFiatAmount(e.target.value)}
              inputMode="decimal"
              placeholder="5000"
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Rail">
          <input
            value={fiatRail}
            onChange={(e) => setFiatRail(e.target.value)}
            className={inputCls}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-sm font-medium">You receive (BTC)</legend>
        <Field label="Amount (sats)">
          <input
            value={sats}
            onChange={(e) => setSats(e.target.value)}
            inputMode="numeric"
            placeholder="3200000"
            className={inputCls}
          />
        </Field>
        <Field label="Payout">
          <input
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
            className={inputCls}
          />
        </Field>
      </fieldset>

      <div className="text-xs text-neutral-500">
        Escrow:{" "}
        {noEscrow ? (
          <span className="text-red-600">none linked</span>
        ) : escrow ? (
          <span>
            {escrow.content.escrow_type} ({agent.escrowReference})
          </span>
        ) : (
          <span className="font-mono">{agent.escrowReference}</span>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting || noEscrow}
        className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {submitting ? "Publishing 7300…" : "Publish swap request"}
      </button>
    </form>
  );
}

const inputCls =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-900";

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-xs text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
