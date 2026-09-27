"use client";

// AgentRecommendation — discovers eligible agents for a cross-border request
// and shows one recommended agent with the reasons. Recommendation only: the
// customer chooses (onChoose), and the page publishes the swap as before.
//
// All AI work happens server-side via Server Actions; this component only
// renders the sanitised view they return.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { MatchRequest } from "@/lib/matching/agent-matching";
import type { FallbackReason } from "@/lib/recommendation/types";
import {
  countryLabel,
  payoutLabel,
  type AgentSummary,
  type RecommendationView,
} from "@/lib/recommendation/view";
import { shortNpub } from "@/lib/pontmore/nip19";
import {
  discoverEligibleAgents,
  recommendEligibleAgent,
} from "@/app/swap/new/actions";

type Phase =
  | { kind: "discovering" }
  | { kind: "recommending"; eligibleCount: number }
  | { kind: "no_agents" }
  | { kind: "no_eligible"; agentsFound: number }
  | { kind: "failed" }
  | { kind: "ready"; view: RecommendationView };

export const LIMITED_CONFIDENCE_TEXT =
  "Limited confidence — available agent data does not provide enough information to distinguish this agent from the other eligible agents.";

/** Neutral aside explaining why AI wasn't used. Never styled as an error. */
const FALLBACK_NOTE: Partial<Record<FallbackReason, string>> = {
  timeout: "The AI assistant took too long, so we used published capabilities instead.",
  invalid_response: "The AI answer could not be verified against agent data, so we used published capabilities instead.",
  provider_error: "The AI assistant could not be reached, so we used published capabilities instead.",
};

export function AgentRecommendation({
  request,
  chosenPubkey,
  choosingPubkey,
  chooseError,
  onChoose,
  onClear,
}: {
  request: MatchRequest;
  chosenPubkey: string | null;
  choosingPubkey: string | null;
  chooseError: string | null;
  onChoose: (pubkey: string) => void;
  onClear: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "discovering" });

  const run = useCallback(
    async (isActive: () => boolean) => {
      setPhase({ kind: "discovering" });
      try {
        const found = await discoverEligibleAgents(request);
        if (!isActive()) return;
        if (found.status === "no_agents_discovered") return setPhase({ kind: "no_agents" });
        if (found.status === "no_eligible_agents") return setPhase({ kind: "no_eligible", agentsFound: found.agentsFound });
        if (found.status !== "eligible") return setPhase({ kind: "failed" });

        setPhase({ kind: "recommending", eligibleCount: found.eligible.length });
        const rec = await recommendEligibleAgent(request);
        if (!isActive()) return;
        if ("status" in rec) return setPhase({ kind: "failed" });
        if (!rec.recommended) {
          return setPhase(rec.fallbackReason === "no_agents_discovered" ? { kind: "no_agents" } : { kind: "no_eligible", agentsFound: 0 });
        }
        setPhase({ kind: "ready", view: rec });
      } catch {
        if (isActive()) setPhase({ kind: "failed" });
      }
    },
    [request],
  );

  useEffect(() => {
    let active = true;
    run(() => active);
    return () => {
      active = false;
    };
  }, [run]);

  const retry = () => run(() => true);
  const corridor = `${countryLabel(request.origin_country)} → ${countryLabel(request.destination_country)}`;

  if (phase.kind === "discovering" || phase.kind === "recommending") {
    return (
      <Panel>
        <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">
          {phase.kind === "discovering"
            ? "Discovering agents on the network…"
            : `Found ${phase.eligibleCount} eligible ${phase.eligibleCount === 1 ? "agent" : "agents"}. Preparing a recommendation…`}
        </p>
      </Panel>
    );
  }

  if (phase.kind === "no_agents" || phase.kind === "failed") {
    return (
      <Panel>
        <p className="text-sm">
          {phase.kind === "no_agents"
            ? "We couldn't load agents from the network right now."
            : "We couldn't prepare a recommendation right now."}
        </p>
        <button type="button" onClick={retry} className="mt-2 text-sm underline">
          Try again
        </button>
      </Panel>
    );
  }

  if (phase.kind === "no_eligible") {
    return (
      <Panel>
        <p className="text-sm">
          No agent currently publishes support for {corridor} payouts in{" "}
          {request.destination_currency} via {payoutLabel(request.payout_method)}.
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          You can browse the <Link href="/agents" className="underline">agents list</Link> or try again later.
        </p>
      </Panel>
    );
  }

  const { view } = phase;
  const rec = view.recommended!;
  const ai = view.source === "ai";
  const chosen = chosenPubkey === rec.pubkey;

  return (
    <Panel label="Agent recommendation">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {ai ? "AI Recommended Agent" : "Recommended Agent"}
        </p>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {ai ? "AI suggestion" : "Published capabilities"}
        </span>
      </div>

      <h3 className="mt-2 text-lg font-semibold">{rec.name ?? "Unnamed agent"}</h3>
      <p className="font-mono text-xs text-neutral-500">{shortNpub(rec.pubkey)}</p>

      <p className="mt-3 text-sm font-medium">Why this agent?</p>
      {ai ? (
        <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{view.customerExplanation}</p>
      ) : (
        <div className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
          <p>Recommended based on published capabilities.</p>
          <p className="text-xs text-neutral-500">AI recommendation unavailable.</p>
          {view.fallbackReason && FALLBACK_NOTE[view.fallbackReason] && (
            <p className="text-xs text-neutral-500">{FALLBACK_NOTE[view.fallbackReason]}</p>
          )}
        </div>
      )}

      <Checks labels={rec.verified} />

      {view.confidence === "limited" && view.eligibleCount > 1 && (
        <p className="mt-3 rounded bg-neutral-50 p-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          {LIMITED_CONFIDENCE_TEXT}
        </p>
      )}

      <p className="mt-3 text-xs text-neutral-500">
        Based on published agent capabilities
        {ai ? " · the AI explanation is checked against that data" : ""}.
      </p>
      {view.missingInformation.length > 0 && (
        <details className="mt-1 text-xs text-neutral-500">
          <summary className="cursor-pointer">Not verified ({view.missingInformation.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {view.missingInformation.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        {chosen ? (
          <p className="text-sm">
            ✓ You chose <span className="font-medium">{rec.name ?? shortNpub(rec.pubkey)}</span>.{" "}
            <button type="button" onClick={onClear} className="text-xs underline">
              Change
            </button>
          </p>
        ) : (
          <ChooseButton
            label="Choose this agent"
            busy={choosingPubkey === rec.pubkey}
            disabled={!!choosingPubkey}
            onClick={() => onChoose(rec.pubkey)}
            primary
          />
        )}
        {chooseError && <p className="mt-2 text-sm text-red-600">{chooseError}</p>}
        <p className="mt-2 text-xs text-neutral-500">
          Nothing is sent until you publish the swap request below.
        </p>
      </div>

      {view.alternatives.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs text-neutral-500">
            Other eligible agents ({view.alternatives.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {view.alternatives.map((a) => (
              <Alternative
                key={a.pubkey}
                agent={a}
                chosen={chosenPubkey === a.pubkey}
                busy={choosingPubkey === a.pubkey}
                disabled={!!choosingPubkey}
                onChoose={() => onChoose(a.pubkey)}
              />
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

function Panel({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      {children}
    </section>
  );
}

function Checks({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Verified from published capabilities">
      {labels.map((l) => (
        <li
          key={l}
          className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        >
          ✓ {l}
        </li>
      ))}
    </ul>
  );
}

function ChooseButton({
  label,
  busy,
  disabled,
  onClick,
  primary,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          : "rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-neutral-700"
      }
    >
      {busy ? "Loading agent…" : label}
    </button>
  );
}

function Alternative({
  agent,
  chosen,
  busy,
  disabled,
  onChoose,
}: {
  agent: AgentSummary & { verified: string[] };
  chosen: boolean;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <li className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{agent.name ?? shortNpub(agent.pubkey)}</span>
        {chosen ? (
          <span className="text-xs">✓ Chosen</span>
        ) : (
          <ChooseButton label="Choose" busy={busy} disabled={disabled} onClick={onChoose} />
        )}
      </div>
      <Checks labels={agent.verified} />
    </li>
  );
}
