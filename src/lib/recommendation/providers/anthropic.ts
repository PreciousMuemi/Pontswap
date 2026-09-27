// lib/recommendation/providers/anthropic.ts
//
// Claude implementation of RecommendationProvider. Server-only: importing this
// from a Client Component is a build error, so the API key cannot reach the
// browser. The key is passed in from server config, never hardcoded.
//
// Returns the model's raw JSON; recommend.ts validates it. A response that is
// not valid JSON is returned as-is so validation rejects it as
// "invalid_response" rather than it looking like an outage.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { SYSTEM_PROMPT, renderUserMessage } from "../prompt";
import { aiOutputSchema, type RecommendationProvider } from "../types";
import type { AiConfig } from "../config";

export function createAnthropicProvider(config: AiConfig): RecommendationProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0, // the caller's timeout bounds total wall-clock; fallback covers failures
  });

  return {
    name: "anthropic",
    async recommend(input, { signal }) {
      const response = await client.beta.messages.create(
        {
          model: config.model,
          max_tokens: 16000,
          // If the model declines, the API retries on a fallback model
          // server-side; a final refusal still falls back deterministically.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: {
            effort: "low", // small, well-specified choice among pre-vetted candidates
            format: betaZodOutputFormat(aiOutputSchema(input)),
          },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: renderUserMessage(input) }],
        },
        { signal },
      );

      if (response.stop_reason === "refusal") throw new Error("model declined the request");
      if (response.stop_reason === "max_tokens") throw new Error("model output was truncated");

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
  };
}
