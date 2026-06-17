// lib/pontmore/nip19.ts
//
// npub <-> hex helpers, used only at the UI edge. Internal code everywhere else
// speaks 64-char hex (matching the zod schemas in kinds.ts).

import { npubEncode, decode } from "nostr-tools/nip19";

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

/** Encode a 64-char hex pubkey as an npub. Throws on malformed hex. */
export function hexToNpub(hex: string): string {
  if (!HEX_PUBKEY.test(hex)) {
    throw new Error("expected 64-char hex pubkey");
  }
  return npubEncode(hex);
}

/**
 * Decode an npub to hex. Accepts a value that is already hex and returns it
 * unchanged, so UI inputs can take either form. Throws if neither.
 */
export function npubToHex(value: string): string {
  const trimmed = value.trim();
  if (HEX_PUBKEY.test(trimmed)) return trimmed.toLowerCase();
  const { type, data } = decode(trimmed);
  if (type !== "npub" || typeof data !== "string") {
    throw new Error("expected an npub or 64-char hex pubkey");
  }
  return data;
}

/** Best-effort decode for display; returns null instead of throwing. */
export function tryNpubToHex(value: string): string | null {
  try {
    return npubToHex(value);
  } catch {
    return null;
  }
}

/** Short, human-friendly form of a pubkey for labels (npub1abc…wxyz). */
export function shortNpub(hex: string): string {
  try {
    const npub = hexToNpub(hex);
    return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
  } catch {
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }
}
