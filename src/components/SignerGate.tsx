"use client";

// SignerGate — identity provider + gate.
//
// Provides a single `useSigner()` hook to the whole app via React context, and
// a <SignerGate> wrapper that renders a connect prompt until an identity is
// chosen. Two identity methods: a NIP-07 browser extension (primary) or an
// in-memory dev key (testing only, clearly labeled).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { generateSecretKey } from "nostr-tools/pure";
import {
  getNip07Signer,
  getDevSigner,
  hasNip07,
  nip07SupportsNip44,
  type Signer,
} from "@/lib/pontmore/signer";
import { shortNpub } from "@/lib/pontmore/nip19";

type SignerMethod = "nip07" | "dev";

type SignerState = {
  signer: Signer | null;
  pubkey: string | null;
  method: SignerMethod | null;
  /** Whether the active signer supports NIP-44 (gift wrap). */
  nip44Supported: boolean;
  error: string | null;
  connectNip07: () => Promise<void>;
  connectDev: (secretKeyHex: string) => Promise<void>;
  disconnect: () => void;
};

const SignerContext = createContext<SignerState | null>(null);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function SignerProvider({ children }: { children: ReactNode }) {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [method, setMethod] = useState<SignerMethod | null>(null);
  const [nip44Supported, setNip44Supported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectNip07 = useCallback(async () => {
    setError(null);
    const s = getNip07Signer();
    if (!s) {
      setError(
        "No NIP-07 extension found. Install Alby or nos2x, or use the dev key.",
      );
      return;
    }
    try {
      const pk = await s.getPublicKey();
      setSigner(s);
      setPubkey(pk);
      setMethod("nip07");
      setNip44Supported(nip07SupportsNip44());
    } catch {
      setError("The extension rejected the connection request.");
    }
  }, []);

  const connectDev = useCallback(async (secretKeyHex: string) => {
    setError(null);
    try {
      const s = getDevSigner(secretKeyHex.trim());
      const pk = await s.getPublicKey();
      setSigner(s);
      setPubkey(pk);
      setMethod("dev");
      setNip44Supported(true);
    } catch {
      setError("Invalid secret key — expected 64-char hex.");
    }
  }, []);

  const disconnect = useCallback(() => {
    setSigner(null);
    setPubkey(null);
    setMethod(null);
    setNip44Supported(false);
    setError(null);
  }, []);

  const value = useMemo<SignerState>(
    () => ({
      signer,
      pubkey,
      method,
      nip44Supported,
      error,
      connectNip07,
      connectDev,
      disconnect,
    }),
    [
      signer,
      pubkey,
      method,
      nip44Supported,
      error,
      connectNip07,
      connectDev,
      disconnect,
    ],
  );

  return (
    <SignerContext.Provider value={value}>{children}</SignerContext.Provider>
  );
}

export function useSigner(): SignerState {
  const ctx = useContext(SignerContext);
  if (!ctx) {
    throw new Error("useSigner must be used within a SignerProvider");
  }
  return ctx;
}

// --- Gate UI -------------------------------------------------------------

/**
 * Renders `children` only when an identity is connected. Otherwise shows the
 * connect prompt. Use to wrap any page or section that needs a signed-in actor.
 */
export function SignerGate({ children }: { children: ReactNode }) {
  const { pubkey } = useSigner();
  if (!pubkey) return <ConnectPrompt />;
  return <>{children}</>;
}

function ConnectPrompt() {
  const { connectNip07, connectDev, error } = useSigner();
  const [devKey, setDevKey] = useState("");
  const [showDev, setShowDev] = useState(false);

  return (
    <div className="mx-auto max-w-md rounded-lg border border-neutral-300 p-6 dark:border-neutral-700">
      <h2 className="text-lg font-semibold">Connect an identity</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Sign in with a Nostr browser extension to start or join a swap.
      </p>

      <button
        type="button"
        onClick={connectNip07}
        className="mt-4 w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Connect NIP-07 extension
      </button>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={() => setShowDev((v) => !v)}
        className="mt-4 text-xs text-neutral-500 underline"
      >
        {showDev ? "Hide" : "Use a dev key instead"}
      </button>

      {showDev && (
        <div className="mt-3 space-y-2 rounded-md border border-amber-400/50 bg-amber-50 p-3 dark:bg-amber-950/30">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            DEV KEY — testing only. Not a real identity. Do not use real funds.
          </p>
          <input
            value={devKey}
            onChange={(e) => setDevKey(e.target.value)}
            placeholder="64-char hex secret key"
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-900"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDevKey(bytesToHex(generateSecretKey()))}
              className="rounded border border-neutral-400 px-2 py-1 text-xs"
            >
              Generate
            </button>
            <button
              type="button"
              onClick={() => connectDev(devKey)}
              className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white"
            >
              Use this key
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact display of the connected identity, with a disconnect control. */
export function SignerBadge() {
  const { pubkey, method, disconnect } = useSigner();
  if (!pubkey) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-mono">{shortNpub(pubkey)}</span>
      {method === "dev" && (
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
          dev
        </span>
      )}
      <button
        type="button"
        onClick={disconnect}
        className="text-xs text-neutral-500 underline"
      >
        disconnect
      </button>
    </div>
  );
}
