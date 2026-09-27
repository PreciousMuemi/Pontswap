"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchAgents, type AgentDefinition } from "@/lib/pontmore/discovery";
import { AgentCard } from "@/components/agents/AgentCard";
import { RelayStatus } from "@/components/RelayStatus";

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  useEffect(() => {
    let active = true;
    fetchAgents({ limit: 100 })
      .then((list) => {
        if (!active) return;
        setAgents(list);
        setStatus("ready");
      })
      .catch(() => active && setStatus("error"));
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm underline">
          ← home
        </Link>
        <RelayStatus />
      </div>

      <h1 className="text-2xl font-semibold">Agents</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Live 30360 agent definitions discovered on the relays. To publish your
        own, use the reference POC at{" "}
        <a
          href="https://poc.pontmore.xyz"
          className="underline"
          target="_blank"
          rel="noreferrer"
        >
          poc.pontmore.xyz
        </a>
        .
      </p>
      <p className="mt-3 text-sm">
        Sending across borders and not sure who to pick?{" "}
        <Link href="/swap/new" className="font-medium underline">
          Get an agent recommendation →
        </Link>
      </p>

      <div className="mt-6 space-y-4">
        {status === "loading" && (
          <p className="text-sm text-neutral-500">Discovering agents…</p>
        )}
        {status === "error" && (
          <p className="text-sm text-red-600">
            Failed to reach the relays. Check your connection and retry.
          </p>
        )}
        {status === "ready" && agents.length === 0 && (
          <p className="text-sm text-neutral-500">
            No agents found on the configured relays.
          </p>
        )}
        {agents.map((agent) => (
          <AgentCard key={agent.pubkey} agent={agent} />
        ))}
      </div>
    </main>
  );
}
