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
import { AgentRecommendation } from "@/components/swap/AgentRecommendation";
import type { MatchRequest } from "@/lib/matching/agent-matching";

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
const COUNTRY_RE = /^[A-Z]{2}$/;

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

  // No agent chosen yet: start a cross-border request and let the customer
  // pick an agent from a recommendation before anything is published.
  if (!agentParam) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold">Start a cross-border swap</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Enter the details, then choose an agent. We&apos;ll suggest one —
          you decide.
        </p>
        <SignerGate>
          <SwapForm agent={null} escrow={null} />
        </SignerGate>
      </Shell>
    );
  }

  if (load === "loading") return <Shell>Loading agent…</Shell>;
  if (load === "notfound" || !agent) {
    return (
      <Shell>
        <p className="text-sm text-red-600">
          Could not find that agent on the relays.
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

/**
 * With `agent` set (from ?agent=), this is the original agent-first form.
 * With `agent` null, the customer describes a cross-border request, gets a
 * recommendation, and explicitly chooses an agent; the chosen agent then
 * goes through the same publish path.
 */
function SwapForm({
  agent,
  escrow,
}: {
  agent: AgentDefinition | null;
  escrow: EscrowDescriptor | null;
}) {
  const router = useRouter();
  const { signer, pubkey } = useSigner();
  const caps = agent?.content.capabilities;

  const [fiatCurrency, setFiatCurrency] = useState(
    agent ? (caps?.fiat_currencies?.[0] ?? "KES") : "",
  );
  const [fiatAmount, setFiatAmount] = useState("");
  const [fiatRail, setFiatRail] = useState(
    agent ? (caps?.payment_channels?.[0] ?? "mpesa") : "",
  );
  const [sats, setSats] = useState("");
  const [payout, setPayout] = useState(
    caps?.settlement_networks?.[0] ?? "lightning",
  );

  // Cross-border corridor. Origin currency/amount reuse the fiat leg above.
  const [crossBorder, setCrossBorder] = useState(!agent);
  const [originCountry, setOriginCountry] = useState("");
  const [destCountry, setDestCountry] = useState("");
  const [destCurrency, setDestCurrency] = useState("");
  const [payoutMethod, setPayoutMethod] = useState("mpesa");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Recommendation + customer choice (agent-less mode only). `recommendFor`
  // snapshots the request the recommendation was made for; editing any field
  // afterwards makes it stale, which clears the choice.
  const [recommendFor, setRecommendFor] = useState<{
    key: string;
    request: MatchRequest;
    nonce: number;
    invalidated: boolean;
  } | null>(null);
  const [chosen, setChosen] = useState<AgentDefinition | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);

  const matchRequest: MatchRequest = {
    origin_country: originCountry,
    destination_country: destCountry,
    origin_currency: fiatCurrency.trim().toUpperCase(),
    destination_currency: destCurrency.trim(),
    amount: fiatAmount.trim(),
    payout_method: payoutMethod.trim(),
    settlement_asset: "BTC",
    ...(payout.trim() ? { settlement_network: payout.trim() } : {}),
  };
  const requestKey = JSON.stringify(matchRequest);
  // Once the details change, the recommendation is discarded for good —
  // changing them back does not silently restore it or re-run the AI.
  const stale = !!recommendFor && (recommendFor.invalidated || recommendFor.key !== requestKey);
  useEffect(() => {
    if (recommendFor && !recommendFor.invalidated && recommendFor.key !== requestKey) {
      setRecommendFor({ ...recommendFor, invalidated: true });
    }
  }, [recommendFor, requestKey]);
  const chosenAgent = !agent && !stale && crossBorder ? chosen : null;

  // The agent the swap will be published to: preselected, or customer-chosen.
  const target = agent ?? chosenAgent;
  const noEscrow = !!target && !target.escrowReference;
  const cannotSubmitToSelf = !!target && pubkey === target.pubkey;
  const awaitingChoice = !agent && !!recommendFor && !stale && !chosenAgent;

  function fieldError(): string | null {
    if (!FIAT_AMOUNT_RE.test(fiatAmount)) return "Fiat amount must be a number, e.g. 5000.";
    if (!SATS_RE.test(sats)) return "Bitcoin amount must be a whole number of sats.";
    if (fiatCurrency.trim().length < 3) return "Currency code looks too short.";
    if (!fiatRail.trim()) return "Rail is required, e.g. mtn-momo.";
    if (crossBorder) {
      if (!COUNTRY_RE.test(originCountry) || !COUNTRY_RE.test(destCountry)) {
        return "Countries must be 2-letter ISO codes, e.g. UG, KE.";
      }
      if (destCurrency.trim().length < 3) return "Destination currency code looks too short.";
      if (!payoutMethod.trim()) return "Payout method is required.";
    }
    return null;
  }

  async function chooseAgent(agentPubkey: string) {
    setChooseError(null);
    setChoosing(agentPubkey);
    try {
      // Same client-side discovery the ?agent= path uses.
      const a = (await fetchAgent(agentPubkey)) ?? (await fetchAgent(agentPubkey));
      if (!a) setChooseError("Couldn't load this agent from the network. Try again.");
      else if (!a.escrowReference) setChooseError("This agent has no escrow descriptor — choose another agent.");
      else setChosen(a);
    } catch {
      setChooseError("Couldn't load this agent from the network. Try again.");
    } finally {
      setChoosing(null);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!signer) {
      setError("Connect an identity first.");
      return;
    }

    // Agent-less mode, no agent chosen yet: validate and ask for a
    // recommendation. Nothing is published here.
    if (!target) {
      if (!crossBorder) {
        setError("For fiat → BTC, pick an agent from the agents list.");
        return;
      }
      const invalid = fieldError();
      if (invalid) {
        setError(invalid);
        return;
      }
      setChosen(null);
      setChooseError(null);
      setRecommendFor({ key: requestKey, request: matchRequest, nonce: Date.now(), invalidated: false });
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
    const invalid = fieldError();
    if (invalid) {
      setError(invalid);
      return;
    }

    setSubmitting(true);
    try {
      const { swapId } = await publishSwapRequest(signer, {
        agentPubkey: target.pubkey,
        escrowReference: target.escrowReference!,
        fiat: {
          currency: fiatCurrency.trim(),
          amount: fiatAmount.trim(),
          rail: fiatRail.trim(),
        },
        bitcoin: { amount_sats: sats.trim(), payout: payout.trim() },
        ...(crossBorder
          ? {
              corridor: {
                origin_country: originCountry,
                destination_country: destCountry,
                destination_currency: destCurrency.trim(),
                payout_method: payoutMethod.trim(),
                settlement_asset: "BTC" as const,
              },
            }
          : {}),
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
      <div className="flex gap-4 text-xs text-neutral-500">
        <span>Direction:</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={!crossBorder}
            onChange={() => setCrossBorder(false)}
          />
          fiat → BTC
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={crossBorder}
            onChange={() => setCrossBorder(true)}
          />
          cross-border (BTC-settled)
        </label>
      </div>
      {!agent && !crossBorder && (
        <p className="text-xs text-neutral-500">
          For fiat → BTC, pick an agent from the{" "}
          <Link href="/agents" className="underline">
            agents list
          </Link>
          .
        </p>
      )}

      <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-sm font-medium">You pay (fiat)</legend>
        {crossBorder && (
          <Field label="Origin country">
            <input
              value={originCountry}
              onChange={(e) => setOriginCountry(e.target.value.toUpperCase())}
              placeholder="UG"
              maxLength={2}
              className={inputCls}
            />
          </Field>
        )}
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

      {crossBorder && (
        <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <legend className="px-1 text-sm font-medium">
            Recipient gets (fiat)
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Destination country">
              <input
                value={destCountry}
                onChange={(e) => setDestCountry(e.target.value.toUpperCase())}
                placeholder="KE"
                maxLength={2}
                className={inputCls}
              />
            </Field>
            <Field label="Currency">
              <input
                value={destCurrency}
                onChange={(e) => setDestCurrency(e.target.value.toUpperCase())}
                placeholder="KES"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Payout method">
            <input
              value={payoutMethod}
              onChange={(e) => setPayoutMethod(e.target.value)}
              className={inputCls}
            />
          </Field>
          <p className="text-xs text-neutral-500">
            Amount: <span className="font-medium">pending a quote</span> — no
            rate source is connected yet, so the recipient amount is not set.
          </p>
        </fieldset>
      )}

      <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-sm font-medium">
          {crossBorder ? "Settlement (BTC)" : "You receive (BTC)"}
        </legend>
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

      {!agent && crossBorder && recommendFor && !stale && (
        <AgentRecommendation
          key={recommendFor.nonce}
          request={recommendFor.request}
          chosenPubkey={chosenAgent?.pubkey ?? null}
          choosingPubkey={choosing}
          chooseError={chooseError}
          onChoose={chooseAgent}
          onClear={() => setChosen(null)}
        />
      )}
      {!agent && crossBorder && stale && (
        <p className="text-xs text-neutral-500">
          The details changed — find an agent again for the updated request.
        </p>
      )}

      {agent ? (
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
      ) : chosenAgent ? (
        <div className="text-xs text-neutral-500">Escrow: linked</div>
      ) : null}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting || noEscrow || awaitingChoice || (!agent && !crossBorder)}
        className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {submitting
          ? "Publishing 7300…"
          : agent
            ? "Publish swap request"
            : chosenAgent
              ? `Publish swap request to ${chosenAgent.content.name}`
              : awaitingChoice
                ? "Choose an agent above to continue"
                : "Find an agent"}
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
