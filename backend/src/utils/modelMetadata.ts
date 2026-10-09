export type ModelReasoningMode =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.6-latest": "gpt-5.6-sol",
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5.5-latest": "gpt-5.5",
  "gpt-5.4-latest": "gpt-5.4",
  "claude-fable-5-latest": "claude-fable-5",
  "claude-opus-5-latest": "claude-opus-5",
  "claude-sonnet-5-latest": "claude-sonnet-5",
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-mythos": "claude-mythos-preview",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-opus-4.5": "claude-opus-4-5",
  "claude-opus-4.1": "claude-opus-4-1",
  "kimi-k3-latest": "kimi-k3",
};

export function normalizeModelId(model: string): string {
  if (!model) return model;
  const trimmed = model.trim();
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

// Keep the most specific identifiers first. Resolution also sorts by length so
// a future insertion cannot make `gpt-5.4` shadow `gpt-5.4-mini` again.
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6": 1_050_000,
  "gpt-5.5": 1_000_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.4": 1_000_000,
  "gpt-5.3-codex-spark": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo-preview": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  "gpt-5-nano": 128_000,
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-mythos-preview": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  "kimi-k3": 1_000_000,
  "kimi-k2.7-code-highspeed": 256_000,
  "kimi-k2.7-code": 256_000,
  "kimi-k2.6": 256_000,
  "MiniMax-M2": 204_800,
  "MiniMax-M2.1": 204_800,
  "MiniMax-M2.1-highspeed": 204_800,
  "MiniMax-M2.5": 204_800,
  "MiniMax-M2.5-highspeed": 204_800,
  "MiniMax-M2.7": 204_800,
  "MiniMax-M2.7-highspeed": 204_800,
  "muse-spark-1.3": 200_000,
};

// The most the model may write back in one turn, when it differs from the
// default below. It is what the compaction reserve in
// services/compaction.service.ts is built on — a prompt must never leave the next
// turn less room than the provider will let it use — and it is also the
// `max_tokens` sent with every request. Record a model here only to correct the
// default: a model with a real ceiling below 32k (an 8k or 16k model) will be
// asked for more than it can write unless it is listed.
// Keep the most specific identifiers first, as above.
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "muse-spark-1.3": 32_000,
};

// What a model with no entry here is assumed to hold, and what the agent plans
// its working set against when Settings declares nothing either. It is the
// window this installation is built around (a 200k-window model writing up to
// 32k a turn), not a guess about any particular vendor: a smaller model that is
// never declared will summarize later than it should, which is why declaring it
// in Settings is worth doing.
export const DEFAULT_CONTEXT_LIMIT = 200_000;

// The output ceiling assumed for a model nobody declared anything about. Used
// both as the `max_tokens` sent with a request and as the floor of the
// compaction reserve, so the two can never disagree: a prompt never leaves the
// next turn less room to answer than the request itself allows.
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

const SORTED_CONTEXT_LIMITS = Object.entries(MODEL_CONTEXT_LIMITS).sort(
  ([a], [b]) => b.length - a.length,
);

/**
 * A `declared` window from Settings wins over this table: it describes the
 * endpoint this install actually dials, which the model name alone cannot.
 */
export function getModelContextLimit(model: string, declared?: number): number {
  if (declared && declared > 0) return declared;
  const normalized = normalizeModelId(model);
  return (
    SORTED_CONTEXT_LIMITS.find(([key]) => normalized.includes(key))?.[1] ??
    DEFAULT_CONTEXT_LIMIT
  );
}

const SORTED_MAX_OUTPUT_TOKENS = Object.entries(MODEL_MAX_OUTPUT_TOKENS).sort(
  ([a], [b]) => b.length - a.length,
);

/**
 * The model's output ceiling: what Settings declared, else what this table knows
 * about that model, else DEFAULT_MAX_OUTPUT_TOKENS. It is never undefined — the
 * ceiling is also the compaction reserve, and a reserve of "unknown" is a plan
 * that overruns the window. A model whose real ceiling is lower than the default
 * wants declaring (Settings, or this table), because the ceiling is what the
 * request asks for.
 */
export function getModelMaxOutput(model: string, declared?: number): number {
  if (declared && declared > 0) return declared;
  const normalized = normalizeModelId(model);
  return (
    SORTED_MAX_OUTPUT_TOKENS.find(([key]) => normalized.includes(key))?.[1] ??
    DEFAULT_MAX_OUTPUT_TOKENS
  );
}
