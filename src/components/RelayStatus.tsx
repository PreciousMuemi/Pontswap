"use client";

// RelayStatus — shows how many configured relays currently have an open
// connection. Polls the SimplePool's connection map on an interval, since the
// pool opens sockets lazily on first read/write.

import { useEffect, useState } from "react";
import { connectionStatus, getRelays } from "@/lib/pontmore/relay";

export function RelayStatus() {
  const total = getRelays().length;
  const [connected, setConnected] = useState(0);

  useEffect(() => {
    const tick = () => {
      const status = connectionStatus();
      let live = 0;
      for (const open of status.values()) if (open) live++;
      setConnected(live);
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  const allUp = connected === total && total > 0;
  return (
    <div className="flex items-center gap-2 text-sm text-neutral-500">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          connected === 0
            ? "bg-neutral-400"
            : allUp
              ? "bg-green-500"
              : "bg-amber-500"
        }`}
        aria-hidden
      />
      <span>
        {connected}/{total} relays
      </span>
    </div>
  );
}
