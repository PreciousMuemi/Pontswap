// lib/pontmore/kinds.ts
//
// Zod schemas for Pontmore event content payloads (PIP-00 through PIP-02).
//
// Nostr events carry a string `content` field that holds JSON for these
// kinds. These schemas validate the *parsed* JSON, not the event envelope.
// Tag conventions and publish/subscribe helpers live in lib/pontmore/swap.ts.

import { z } from "zod";
import { SWAP_STATES, ACTOR_ROLES } from "./states";

// --- Nostr kind numbers --------------------------------------------------

export const KIND_AGENT_DEFINITION = 30360 as const;
export const KIND_ESCROW_DESCRIPTOR = 30361 as const;
export const KIND_SWAP_REQUEST = 7300 as const;
export const KIND_TRANSITION = 7301 as const;
export const KIND_EVIDENCE = 7302 as const;
export const KIND_DISPUTE = 7303 as const;
export const KIND_NOTE = 7304 as const;
export const KIND_SNAPSHOT = 30362 as const;

// NIP-59 Gift Wrap layers (private messaging).
export const KIND_SEAL = 13 as const; // signed by sender, wraps the rumor
export const KIND_RUMOR = 14 as const; // unsigned inner message
export const KIND_GIFT_WRAP = 1059 as const; // signed by an ephemeral key

// --- Shared primitives ---------------------------------------------------

/** 64-character hex Nostr pubkey. UI converts npub <-> hex at the edge. */
export const HexPubkey = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "expected 64-char hex pubkey");

/** NIP-01 addressable coordinate of the form `kind:pubkey:d-tag`. */
export const Coordinate = z
  .string()
  .regex(
    /^\d+:[0-9a-f]{64}:.*$/i,
    "expected coordinate of the form kind:pubkey:d-tag",
  );

export const SwapStateSchema = z.enum(SWAP_STATES);
export const ActorRoleSchema = z.enum(ACTOR_ROLES);

export const SwapTypeSchema = z.enum(["fiat_to_btc", "btc_to_fiat"]);
export type SwapType = z.infer<typeof SwapTypeSchema>;

const UnixSeconds = z.number().int().positive();

// --- Sub-objects ---------------------------------------------------------

/** Amounts are strings to avoid float drift through JSON. */
const FiatLeg = z.object({
  currency: z.string().min(3).max(8), // ISO-ish: KES, USD, NGN, ...
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  rail: z.string().min(1), // mpesa, bank-transfer, mobile-money, ...
});
export type FiatLeg = z.infer<typeof FiatLeg>;

const BitcoinLeg = z.object({
  amount_sats: z.string().regex(/^\d+$/),
  payout: z.string().min(1), // lightning, onchain, ...
});
export type BitcoinLeg = z.infer<typeof BitcoinLeg>;

// --- PIP-02 content schemas ---------------------------------------------

/** kind 7300 — immutable swap request. */
export const SwapRequestContent = z.object({
  version: z.literal(1),
  swap_id: z.string().min(1),
  swap_type: SwapTypeSchema,
  agent: HexPubkey,
  customer: HexPubkey,
  escrow_reference: Coordinate,
  fiat: FiatLeg,
  bitcoin: BitcoinLeg,
  expiry: UnixSeconds,
});
export type SwapRequestContent = z.infer<typeof SwapRequestContent>;

/** kind 7301 — append-only state transition. */
export const TransitionContent = z.object({
  swap_id: z.string().min(1),
  state: SwapStateSchema,
  prev_state: SwapStateSchema,
  actor_role: ActorRoleSchema,
  reason: z.string().min(1),
  created_at: UnixSeconds,
});
export type TransitionContent = z.infer<typeof TransitionContent>;

/** kind 7302 — reveal-by-reference evidence (per PIP-02 evidence handling). */
export const EvidenceContent = z
  .object({
    swap_id: z.string().min(1),
    type: z.string().min(1), // fiat_transfer_reference, escrow_funding_proof, payout_proof, ...
    ref: z.string().optional(), // opaque public reference (e.g. M-Pesa transaction code)
    ref_hash: z.string().optional(), // sha256 of a private artifact, hex
    note: z.string().optional(),
  })
  .refine((v) => v.ref || v.ref_hash, {
    message: "evidence must include at least one of `ref` or `ref_hash`",
  });
export type EvidenceContent = z.infer<typeof EvidenceContent>;

/** kind 7304 — optional human-readable operational note tied to a swap. */
export const NoteContent = z.object({
  swap_id: z.string().min(1),
  text: z.string().min(1),
});
export type NoteContent = z.infer<typeof NoteContent>;

/** kind 30362 — replaceable materialized view of the final swap state. */
export const SnapshotContent = z.object({
  swap_id: z.string().min(1),
  final_state: SwapStateSchema,
  agent: HexPubkey,
  customer: HexPubkey,
  swap_type: SwapTypeSchema,
  fiat: FiatLeg,
  bitcoin: BitcoinLeg,
  transitions: z.array(
    z.object({
      state: SwapStateSchema,
      actor_role: ActorRoleSchema,
      at: UnixSeconds,
      event_id: z
        .string()
        .regex(/^[0-9a-f]{64}$/i)
        .optional(),
    }),
  ),
  evidence_refs: z.array(z.string()).optional(),
  completed_at: UnixSeconds,
});
export type SnapshotContent = z.infer<typeof SnapshotContent>;

// --- PIP-00 / PIP-01 discovery content (read-only) ----------------------
//
// This app is a pure *consumer* of 30360 / 30361. Real demo data on the
// network is inconsistent (two agent shapes, string-or-number limits, the
// reference POC's hyphenated swap_types), and kind 30361 is shared with an
// unrelated NIP-29 group app. These schemas are deliberately lenient so the
// canonical reference-POC agents parse, while `.passthrough()` preserves
// fields the UI doesn't model. Escrow REQUIRES `escrow_type` so non-Pontmore
// noise on 30361 fails validation and is skipped by discovery.ts.

const StringOrNumber = z.union([z.string(), z.number()]);

const AgentLimits = z
  .object({
    min: StringOrNumber.optional(),
    max: StringOrNumber.optional(),
  })
  .passthrough();

const AgentCapabilities = z
  .object({
    swap_types: z.array(z.string()).optional(),
    fiat_currencies: z.array(z.string()).optional(),
    payment_channels: z.array(z.string()).optional(),
    settlement_networks: z.array(z.string()).optional(),
    region: z.string().optional(), // older single-region shape
    regions: z.array(z.string()).optional(), // reference-POC shape
    limits: AgentLimits.optional(),
  })
  .passthrough();

/** kind 30360 — agent definition (PIP-00). */
export const AgentDefinitionContent = z
  .object({
    version: StringOrNumber.optional(),
    name: z.string().min(1),
    about: z.string().optional(),
    // Required: real PIP-00 agents always advertise capabilities. This also
    // rejects unrelated apps that publish bare {"name": ...} on kind 30360
    // (e.g. NIP-29 group snapshots).
    capabilities: AgentCapabilities,
    pricing_policy: z.string().optional(),
    escrow: z
      .object({
        descriptor: z.string().optional(), // 30361 coordinate
        notes: z.string().optional(),
      })
      .passthrough()
      .optional(),
    updated_at: StringOrNumber.optional(),
  })
  .passthrough();
export type AgentDefinitionContent = z.infer<typeof AgentDefinitionContent>;

/** kind 30361 — escrow descriptor (PIP-01). */
export const EscrowDescriptorContent = z
  .object({
    version: StringOrNumber.optional(),
    escrow_type: z.string().min(1), // required: rejects non-Pontmore 30361 noise
    networks: z.array(z.string()).optional(),
    funding_rules: z.record(z.string(), z.unknown()).optional(),
    release_rules: z.record(z.string(), z.unknown()).optional(),
    dispute_rules: z.record(z.string(), z.unknown()).optional(),
    reference_format: z.string().optional(),
  })
  .passthrough();
export type EscrowDescriptorContent = z.infer<typeof EscrowDescriptorContent>;

// --- Private (gift-wrapped) message content -----------------------------
//
// These payloads travel ONLY inside a NIP-59 gift wrap (kind 1059). The
// swap_id lives here, inside the encrypted rumor — never as a public tag.

/** Payment instructions an agent sends privately to a customer. */
export const PaymentInstructionsContent = z.object({
  type: z.literal("payment_instructions"),
  swap_id: z.string().min(1),
  rail: z.string().min(1), // mpesa, bank-transfer, ...
  payee: z.string().min(1), // Till / Paybill / account number
  account: z.string().optional(), // Paybill account reference
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.string().min(3).max(8),
  reference: z.string().optional(), // expected narration the customer should use
  note: z.string().optional(),
});
export type PaymentInstructionsContent = z.infer<
  typeof PaymentInstructionsContent
>;

// --- Helpers -------------------------------------------------------------

/**
 * Parse a Nostr event's `content` string against a schema.
 * Throws on mismatch. Use the schema's `safeParse` directly if you want a
 * Result-style return.
 */
export function parseContent<T extends z.ZodTypeAny>(
  schema: T,
  content: string,
): z.infer<T> {
  return schema.parse(JSON.parse(content));
}

/**
 * Build the canonical addressable coordinate string for an event.
 * Use for kinds 30360 / 30361 / 30362.
 */
export function coordinate(
  kind: number,
  pubkey: string,
  dTag: string,
): string {
  return `${kind}:${pubkey}:${dTag}`;
}
