"use client";

// AgentCard — renders one validated 30360 agent definition with a "Start swap"
// CTA, and lazily reads the linked 30361 escrow descriptor for detail.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchEscrowDescriptor,
  type AgentDefinition,
  type EscrowDescriptor,
} from "@/lib/pontmore/discovery";
import { hexToNpub, shortNpub } from "@/lib/pontmore/nip19";

function regionsOf(agent: AgentDefinition): string[] {
  const caps = agent.content.capabilities;
  if (!caps) return [];
  if (caps.regions?.length) return caps.regions;
  if (caps.region) return [caps.region];
  return [];
}

function Chips({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-neutral-500">{label}:</span>
      {values.map((v) => (
        <span
          key={v}
          className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

export function AgentCard({ agent }: { agent: AgentDefinition }) {
  const caps = agent.content.capabilities;
  const limits = caps?.limits;
  const regions = regionsOf(agent);
  const npub = hexToNpub(agent.pubkey);

  const [escrow, setEscrow] = useState<EscrowDescriptor | null>(null);
  const [escrowState, setEscrowState] = useState<
    "idle" | "loading" | "missing"
  >("idle");

  useEffect(() => {
    if (!agent.escrowReference) return;
    let active = true;
    setEscrowState("loading");
    fetchEscrowDescriptor(agent.escrowReference)
      .then((d) => {
        if (!active) return;
        setEscrow(d);
        setEscrowState(d ? "idle" : "missing");
      })
      .catch(() => active && setEscrowState("missing"));
    return () => {
      active = false;
    };
  }, [agent.escrowReference]);

  return (
    <article className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{agent.content.name}</h3>
          <p className="font-mono text-xs text-neutral-500">
            {shortNpub(agent.pubkey)}
          </p>
        </div>
        {regions.length > 0 && (
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
            {regions.join(", ")}
          </span>
        )}
      </div>

      {agent.content.about && (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {agent.content.about}
        </p>
      )}

      <div className="mt-3 space-y-1">
        <Chips label="Fiat" values={caps?.fiat_currencies} />
        <Chips label="Channels" values={caps?.payment_channels} />
        <Chips label="Settlement" values={caps?.settlement_networks} />
        {limits && (limits.min != null || limits.max != null) && (
          <p className="text-xs text-neutral-500">
            Limits: {limits.min != null ? String(limits.min) : "—"} –{" "}
            {limits.max != null ? String(limits.max) : "—"}
          </p>
        )}
        {agent.content.pricing_policy && (
          <p className="text-xs text-neutral-500">
            Pricing: {agent.content.pricing_policy}
          </p>
        )}
      </div>

      <div className="mt-3 text-xs text-neutral-500">
        {!agent.escrowReference && <span>No escrow descriptor linked.</span>}
        {escrowState === "loading" && <span>Loading escrow…</span>}
        {escrowState === "missing" && (
          <span>Escrow descriptor unavailable.</span>
        )}
        {escrow && (
          <span>
            Escrow: {escrow.content.escrow_type}
            {escrow.content.networks?.length
              ? ` (${escrow.content.networks.join(", ")})`
              : ""}
          </span>
        )}
      </div>

      <div className="mt-4">
        <Link
          href={`/swap/new?agent=${npub}`}
          className="inline-block rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Start swap
        </Link>
      </div>
    </article>
  );
}
