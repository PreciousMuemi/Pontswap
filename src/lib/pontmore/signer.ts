// lib/pontmore/signer.ts
//
// Unified signing interface so the UI never branches on signer type.
//
// Two implementations:
//   - NIP-07 (window.nostr): a browser extension like Alby or nos2x. Primary.
//   - dev local keypair: an in-memory secret key, DEV/TESTING ONLY. The UI must
//     label this clearly and never present it as a real identity.
//
// NIP-44 capability differs across extensions (Alby supports it, older nos2x
// builds may not). The signer detects a missing nip44 and throws a clear error
// rather than failing silently; callers surface it in the UI.

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";
import type { Event, EventTemplate } from "nostr-tools";

export type Signer = {
  /** hex pubkey */
  getPublicKey(): Promise<string>;
  signEvent(unsigned: EventTemplate): Promise<Event>;
  nip44Encrypt(peerHex: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerHex: string, ciphertext: string): Promise<string>;
};

// --- NIP-07 (browser extension) -----------------------------------------

type Nip44Capable = {
  encrypt(pubkey: string, plaintext: string): Promise<string>;
  decrypt(pubkey: string, ciphertext: string): Promise<string>;
};

type WindowNostr = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip44?: Nip44Capable;
};

function getWindowNostr(): WindowNostr | null {
  if (typeof window === "undefined") return null;
  const nostr = (window as unknown as { nostr?: WindowNostr }).nostr;
  return nostr ?? null;
}

/** True if a NIP-07 extension is present in this browser. */
export function hasNip07(): boolean {
  return getWindowNostr() !== null;
}

/** True if the present NIP-07 extension also exposes NIP-44 encryption. */
export function nip07SupportsNip44(): boolean {
  return !!getWindowNostr()?.nip44;
}

const NIP44_UNSUPPORTED =
  "This browser extension does not support NIP-44 encryption. " +
  "Gift-wrapped messages require it — try Alby, or use the dev key for testing.";

export function getNip07Signer(): Signer | null {
  const nostr = getWindowNostr();
  if (!nostr) return null;

  return {
    getPublicKey: () => nostr.getPublicKey(),
    signEvent: (unsigned) => nostr.signEvent(unsigned),
    nip44Encrypt: async (peerHex, plaintext) => {
      if (!nostr.nip44) throw new Error(NIP44_UNSUPPORTED);
      return nostr.nip44.encrypt(peerHex, plaintext);
    },
    nip44Decrypt: async (peerHex, ciphertext) => {
      if (!nostr.nip44) throw new Error(NIP44_UNSUPPORTED);
      return nostr.nip44.decrypt(peerHex, ciphertext);
    },
  };
}

// --- Dev local keypair (TESTING ONLY) -----------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) {
    throw new Error("invalid hex secret key");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * In-memory signer backed by a raw secret key. DEV/TESTING ONLY.
 * The secret key never leaves this closure.
 */
export function getDevSigner(secretKeyHex: string): Signer {
  const sk = hexToBytes(secretKeyHex);
  const pk = getPublicKey(sk);

  return {
    getPublicKey: async () => pk,
    signEvent: async (unsigned) => finalizeEvent(unsigned, sk),
    nip44Encrypt: async (peerHex, plaintext) => {
      const key = getConversationKey(sk, peerHex);
      return encrypt(plaintext, key);
    },
    nip44Decrypt: async (peerHex, ciphertext) => {
      const key = getConversationKey(sk, peerHex);
      return decrypt(ciphertext, key);
    },
  };
}
