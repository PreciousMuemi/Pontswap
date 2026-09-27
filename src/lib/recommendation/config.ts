// lib/recommendation/config.ts
//
// Reads AI settings from server environment variables. Pure: the env is
// passed in, so this is testable without touching process.env.
//
//   ANTHROPIC_API_KEY          required to enable AI (server-side only)
//   PONTSWAP_AI_MODEL          optional, defaults to claude-opus-5
//   PONTSWAP_AI_TIMEOUT_MS     optional, defaults to 20000
//   PONTSWAP_AI_DISABLED=1     optional kill switch -> deterministic only
//
// NEXT_PUBLIC_* variables are never read: Next.js inlines those into the
// browser bundle, so a key there would already be leaked.

import { DEFAULT_TIMEOUT_MS } from "./recommend";

export const DEFAULT_MODEL = "claude-opus-5";

export type AiConfig = { apiKey: string; model: string; timeoutMs: number };

export type AiConfigResult =
  | { ok: true; config: AiConfig }
  | { ok: false; reason: "disabled" | "missing_credentials" };

export function readAiConfig(
  env: Readonly<Record<string, string | undefined>>,
): AiConfigResult {
  if (env.PONTSWAP_AI_DISABLED === "1") return { ok: false, reason: "disabled" };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "missing_credentials" };

  const timeout = Number(env.PONTSWAP_AI_TIMEOUT_MS);
  return {
    ok: true,
    config: {
      apiKey,
      model: env.PONTSWAP_AI_MODEL?.trim() || DEFAULT_MODEL,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    },
  };
}
