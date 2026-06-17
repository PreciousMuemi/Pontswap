// lib/pontmore/gift-wrap.ts
//
// NIP-59 Gift Wrap over the unified Signer interface.
//
// Why not nostr-tools' nip59.wrapEvent / unwrapEvent directly? Those take a raw
// Uint8Array private key. A NIP-07 browser extension never exposes the private
// key, so the library helpers cannot wrap/unwrap for a NIP-07 identity. We
// instead assemble the three NIP-59 layers using the Signer (signEvent +
// nip44Encrypt/Decrypt), and a fresh ephemeral key for the outer wrap. The
// crypto primitives are still nostr-tools' NIP-44 — nothing hand-rolled.
//
// Layers (NIP-59):
//   rumor (kind 14)  — unsigned inner message, content = the real payload JSON
//   seal  (kind 13)  — signed by SENDER, content = nip44(sender→recipient, rumor)
//   wrap  (kind 1059)— signed by EPHEMERAL key, content = nip44(ephemeral→recipient, seal)
//
// created_at on the seal and wrap is randomized into the past so the relay
// timeline leaks nothing about when the message was actually sent.

import {
  generateSecretKey,
  finalizeEvent,
  getEventHash,
  verifyEvent,
} from "nostr-tools/pure";
import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import type { Event } from "nostr-tools";
import type { Signer } from "./signer";
import { publishEvent, subscribe } from "./relay";
import { KIND_SEAL, KIND_RUMOR, KIND_GIFT_WRAP } from "./kinds";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const TWO_DAYS = 2 * 24 * 60 * 60;
/** A timestamp up to two days in the past, per NIP-59 timing-privacy guidance. */
const randomPastTs = () => nowSeconds() - Math.floor(Math.random() * TWO_DAYS);

/**
 * Build a gift-wrapped (kind 1059) event carrying `payload` from the signer to
 * `recipientHex`. The payload is JSON-serialized into the inner rumor.
 */
export async function buildGiftWrap(
  signer: Signer,
  recipientHex: string,
  payload: unknown,
): Promise<Event> {
  const senderHex = await signer.getPublicKey();

  // Rumor (kind 14) — unsigned; carries an id but no signature.
  const rumorBase = {
    pubkey: senderHex,
    created_at: nowSeconds(),
    kind: KIND_RUMOR,
    tags: [["p", recipientHex]],
    content: JSON.stringify(payload),
  };
  const rumor = { ...rumorBase, id: getEventHash(rumorBase) };

  // Seal (kind 13) — signed by the sender, encrypts the rumor sender→recipient.
  const sealContent = await signer.nip44Encrypt(
    recipientHex,
    JSON.stringify(rumor),
  );
  const seal = await signer.signEvent({
    kind: KIND_SEAL,
    created_at: randomPastTs(),
    tags: [],
    content: sealContent,
  });

  // Wrap (kind 1059) — signed by a throwaway ephemeral key; hides the sender.
  const ephemeral = generateSecretKey();
  const wrapKey = getConversationKey(ephemeral, recipientHex);
  const wrap = finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: randomPastTs(),
      tags: [["p", recipientHex]],
      content: nip44Encrypt(JSON.stringify(seal), wrapKey),
    },
    ephemeral,
  );
  return wrap;
}

/** Build and publish a gift wrap. Returns the wrap event. */
export async function sendGiftWrap(
  signer: Signer,
  recipientHex: string,
  payload: unknown,
): Promise<Event> {
  const wrap = await buildGiftWrap(signer, recipientHex, payload);
  await publishEvent(wrap);
  return wrap;
}

export type UnwrappedMessage = {
  /** Authenticated sender (from the signed seal). */
  senderHex: string;
  /** Parsed inner payload. */
  payload: unknown;
  /** Real send time, recovered from the rumor (not the randomized wrap time). */
  createdAt: number;
};

/**
 * Decrypt a kind-1059 wrap addressed to the signer. Returns null if any layer
 * fails to decrypt/parse or if the seal signature is invalid (forged sender).
 */
export async function unwrapGiftWrap(
  signer: Signer,
  wrap: Event,
): Promise<UnwrappedMessage | null> {
  try {
    // Outer: ephemeral → me.
    const sealJson = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
    const seal = JSON.parse(sealJson) as Event;
    if (seal.kind !== KIND_SEAL || !verifyEvent(seal)) return null;

    // Inner: sender → me. seal.pubkey is the authenticated sender.
    const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
    const rumor = JSON.parse(rumorJson) as { content: string; created_at: number };

    return {
      senderHex: seal.pubkey,
      payload: JSON.parse(rumor.content),
      createdAt: rumor.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to inbound gift wraps addressed to `myPubkey`. Gift wraps carry no
 * swap_id publicly, so callers decrypt each one and filter by the inner
 * payload's swap_id. Returns an unsubscribe function.
 */
export function subscribeGiftWraps(
  myPubkey: string,
  onWrap: (wrap: Event) => void,
): () => void {
  return subscribe([{ kinds: [KIND_GIFT_WRAP], "#p": [myPubkey] }], onWrap);
}
