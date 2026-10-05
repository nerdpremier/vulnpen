import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { observeOpenAI } from "@langfuse/openai";
import type { LangfuseGeneration } from "@langfuse/tracing";
import { startObservation } from "@langfuse/tracing";
import { readEnvFile, updateEnvVars } from "../envWriter";
import { isTracingEnabled } from "../tracing";
import {
  buildAnthropicMessageParams,
  buildAnthropicStreamParams,
} from "./anthropicParams";
import { normalizeModelId } from "../modelMetadata";
import { createStreamCollector } from "./streamCollector";
import {
  invokeSubscriptionInference,
  isSubscriptionProvider,
} from "../../services/subscription-inference.service";

export type ProviderType =
  | "openai"
  | "anthropic"
  | "anthropic-compatible"
  | "openrouter"
  | "ollama"
  | "openai-compatible"
  | "google"
  | "mistralai"
  | "kimi"
  | "minimax"
  | "bedrock"
  | "codex-subscription"
  | "claude-subscription";

export interface ProviderConfig {
  provider: ProviderType;
  apiKey: string;
  model: string;
  baseURL?: string;
  authMethod?: "api_key" | "oauth" | "subscription";
  oauthAccessToken?: string;
}

/**
 * MiniMax speaks the Anthropic Messages API on this endpoint, so it reuses the
 * Anthropic client path rather than the OpenAI one. Previously MiniMax was only
 * reachable by selecting "Anthropic-Compatible" and typing this URL by hand.
 */
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";

const PROVIDER_DEFAULTS: Record<ProviderType, { baseURL: string }> = {
  openai: { baseURL: "https://api.openai.com/v1" },
  anthropic: { baseURL: "https://api.anthropic.com/v1/" },
  "anthropic-compatible": { baseURL: "" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1" },
  ollama: {
    baseURL: process.env.VULNPEN_DOCKER === "1"
      ? "http://host.docker.internal:11434/v1"
      : "http://localhost:11434/v1",
  },
  "openai-compatible": { baseURL: "" },
  google: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  mistralai: { baseURL: "https://api.mistral.ai/v1" },
  kimi: { baseURL: "https://api.moonshot.ai/v1" },
  minimax: { baseURL: MINIMAX_ANTHROPIC_BASE_URL },
  // Region-specific; resolved at call time by bedrockBaseURL().
  bedrock: { baseURL: "" },
  "codex-subscription": { baseURL: "" },
  "claude-subscription": { baseURL: "" },
};

export const DEFAULT_BEDROCK_REGION = "us-east-1";

/**
 * AWS Bedrock exposes an OpenAI-compatible endpoint authenticated with a
 * long-term Bedrock API key as a bearer token, so it rides the standard OpenAI
 * client path — no SigV4 signing required.
 *
 * The region is part of the hostname. An explicit baseURL always wins; failing
 * that we read BEDROCK_REGION / AWS_REGION, then fall back to us-east-1.
 */
export function bedrockBaseURL(baseURL?: string): string {
  if (baseURL) return baseURL.replace(/\/+$/, "");

  let region = DEFAULT_BEDROCK_REGION;
  try {
    const env = readEnvFile();
    region = env.BEDROCK_REGION || env.AWS_REGION || DEFAULT_BEDROCK_REGION;
  } catch {
    // Env file unreadable — the default region still yields a valid endpoint.
  }

  return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

function isAnthropicApiProvider(provider: ProviderType): boolean {
  return (
    provider === "anthropic" ||
    provider === "anthropic-compatible" ||
    provider === "minimax"
  );
}

function defaultBaseURLForProvider(
  provider: ProviderType,
  baseURL?: string,
): string | undefined {
  if (provider === "bedrock") return bedrockBaseURL(baseURL);
  if (baseURL) return baseURL;
  if (provider === "anthropic-compatible") return undefined;
  return PROVIDER_DEFAULTS[provider]?.baseURL || undefined;
}

function buildClient(config: ProviderConfig): OpenAI {
  const baseURL = defaultBaseURLForProvider(config.provider, config.baseURL);

  const isOAuth =
    config.provider === "anthropic" &&
    config.authMethod === "oauth" &&
    config.oauthAccessToken;
  const isKeylessLocal = config.provider === "ollama" && !config.apiKey;

  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: isOAuth || isKeylessLocal ? "ollama" : config.apiKey,
  };

  if (baseURL) {
    clientOpts.baseURL = baseURL;
  }

  if (isAnthropicApiProvider(config.provider)) {
    if (isOAuth) {
      clientOpts.defaultHeaders = {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        Authorization: `Bearer ${config.oauthAccessToken}`,
      };
    } else {
      clientOpts.defaultHeaders = {
        "anthropic-version": "2023-06-01",
        "x-api-key": config.apiKey,
      };
    }
  }

  return new OpenAI(clientOpts);
}

function buildAnthropicClient(config: ProviderConfig): Anthropic {
  // Only MiniMax gets a default injected here. "anthropic" must keep falling
  // through to the SDK's own default — passing PROVIDER_DEFAULTS' trailing
  // "/v1/" would make the SDK build /v1/v1/messages.
  const baseURL =
    config.baseURL ||
    (config.provider === "minimax" ? MINIMAX_ANTHROPIC_BASE_URL : undefined);

  const clientOptions: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: config.authMethod === "oauth" ? undefined : config.apiKey,
    ...(config.authMethod === "oauth"
      ? { authToken: config.oauthAccessToken }
      : {}),
    ...(baseURL ? { baseURL } : {}),
  };
  return new Anthropic(clientOptions);
}

const ANTHROPIC_OAUTH_TOKEN_URL =
  "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

async function maybeRefreshOAuthToken(): Promise<string | null> {
  const env = readEnvFile();
  const accessToken = env.ANTHROPIC_OAUTH_ACCESS_TOKEN;
  const refreshToken = env.ANTHROPIC_OAUTH_REFRESH_TOKEN;
  const expiresAt = parseInt(env.ANTHROPIC_OAUTH_EXPIRES_AT || "0", 10);

  if (!accessToken || !refreshToken) return null;

  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now > 300) return accessToken;

  try {
    const response = await axios.post(
      ANTHROPIC_OAUTH_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );

    const { access_token, refresh_token, expires_in } = response.data;
    updateEnvVars({
      ANTHROPIC_OAUTH_ACCESS_TOKEN: access_token,
      ANTHROPIC_OAUTH_REFRESH_TOKEN: refresh_token || refreshToken,
      ANTHROPIC_OAUTH_EXPIRES_AT: String(
        Math.floor(Date.now() / 1000) + (expires_in || 3600),
      ),
    });
    return access_token;
  } catch (err) {
    console.warn("[providers] Failed to refresh Anthropic OAuth token:", err);
    return accessToken;
  }
}

async function loadProviderConfig(): Promise<ProviderConfig> {
  const registry = getAssignedModels();
  if (registry.orchestrator) {
    assertOrchestratorVerified(registry.orchestrator);
    return await presetToProviderConfig(registry.orchestrator);
  }

  return {
    provider: "openai",
    apiKey: "",
    model: "gpt-5.6-terra",
    baseURL: undefined,
    authMethod: "api_key",
  };
}

export { normalizeModelId } from "../modelMetadata";

// ─── Provider cache ──────────────────────────────────────────────────

let cachedProvider: ProviderConfig | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

function isCacheStale(): boolean {
  return Date.now() - cacheTimestamp > CACHE_TTL_MS;
}

export async function getProvider(): Promise<ProviderConfig> {
  if (cachedProvider && !isCacheStale()) return cachedProvider;
  cachedProvider = await loadProviderConfig();
  cacheTimestamp = Date.now();
  return cachedProvider;
}

export function clearProviderCache(): void {
  cachedProvider = null;
  cacheTimestamp = 0;
}

// ─── Per-user model config ───────────────────────────────────────────

import { getAssignedModels, ModelPreset } from "../modelRegistryStore";
import { isHostOwner } from "../../services/host-owner.service";

export interface UserModelsResult {
  orchestrator: ModelPreset;
  all: ModelPreset[];
}

/**
 * One guard for the one unverified-orchestrator rule — previously written
 * twice with two different messages (env-default path and per-user path).
 */
function assertOrchestratorVerified(orchestrator: ModelPreset): void {
  if (!orchestrator.verifiedAt) {
    throw new Error(
      `Assigned model "${orchestrator.label}" is unverified. Test and save it in Settings -> Models.`,
    );
  }
}

export function restrictHostSubscriptionModels(
  models: UserModelsResult,
  owner: boolean,
): UserModelsResult {
  if (owner) return models;
  if (isSubscriptionProvider(models.orchestrator.provider)) {
    throw new Error(
      "The configured orchestrator uses a host CLI subscription reserved for the installation owner",
    );
  }
  return {
    orchestrator: models.orchestrator,
    all: models.all.filter(
      (preset) => !isSubscriptionProvider(preset.provider),
    ),
  };
}

export async function getUserModels(
  userId: string,
): Promise<UserModelsResult> {
  const registry = getAssignedModels();
  const owner = await isHostOwner(userId);

  if (!registry.orchestrator) {
    const envConfig = await getProvider();
    const fallback: ModelPreset = {
      id: "default",
      label: envConfig.model,
      provider: envConfig.provider,
      model: envConfig.model,
      apiKey: envConfig.apiKey,
    };
    return restrictHostSubscriptionModels(
      { orchestrator: fallback, all: [fallback] },
      owner,
    );
  }

  assertOrchestratorVerified(registry.orchestrator);

  const models = {
    orchestrator: registry.orchestrator,
    all: registry.all,
  };
  return restrictHostSubscriptionModels(models, owner);
}

export async function presetToProviderConfig(
  preset: ModelPreset,
): Promise<ProviderConfig> {
  const model = normalizeModelId(preset.model);

  if (isSubscriptionProvider(preset.provider)) {
    return {
      provider: preset.provider,
      apiKey: "",
      model,
      authMethod: "subscription",
    };
  }

  if (preset.provider === "anthropic" && !preset.apiKey) {
    const oauthToken = await maybeRefreshOAuthToken();
    if (oauthToken) {
      return {
        provider: "anthropic",
        apiKey: "",
        model,
        baseURL: preset.baseURL || undefined,
        authMethod: "oauth",
        oauthAccessToken: oauthToken,
      };
    }
  }

  const providerType = preset.provider as ProviderType;

  return {
    provider: providerType,
    model,
    apiKey: preset.apiKey || "",
    baseURL: preset.baseURL || undefined,
    authMethod: "api_key",
  };
}

export interface OrchestratorResolution {
  config: ProviderConfig;
  reasoningMode: ReasoningMode;
}

/**
 * The one way to ask "which model orchestrates for this user": the assigned
 * orchestrator (verified, host-owner-restricted) or the env default, as a
 * ready ProviderConfig plus its reasoning mode. Fresh on every call, so
 * model changes in Settings are visible on the next call — callers used to
 * pick between getProvider (global, owner-blind), getProviderForUser
 * (per-user cache that dropped reasoningMode), and the
 * getUserModels + presetToProviderConfig dance; those questions were the
 * same question.
 */
export async function resolveOrchestrator(
  userId: string,
): Promise<OrchestratorResolution> {
  const { orchestrator } = await getUserModels(userId);
  const config = await presetToProviderConfig(orchestrator);
  return {
    config,
    reasoningMode: (orchestrator.reasoningMode as ReasoningMode) || "off",
  };
}

// ─── Shared types ────────────────────────────────────────────────────

export interface ToolCallData {
  id: string;
  name: string;
  arguments: string;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error";

export type ReasoningMode =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface InvokeOptions {
  messages: Array<OpenAI.Chat.ChatCompletionMessageParam>;
  tools?: OpenAI.Chat.ChatCompletionTool[];
  format?: "json" | "text";
  temperature?: number;
  reasoningMode?: ReasoningMode;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  generationName?: string;
  providerOverride?: ProviderConfig;
}

export interface InvokeResult {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCallData[];
  finishReason: FinishReason;
  usage: OpenAI.Completions.CompletionUsage | undefined;
  model: string;
  provider: ProviderType;
  elapsedMs: number;
}

// ─── Streaming types ─────────────────────────────────────────────────

export interface StreamDelta {
  type:
    | "text"
    | "reasoning"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_done";
  content?: string;
  toolCall?: Partial<ToolCallData> & { index?: number };
}

export interface StreamingInvokeOptions extends InvokeOptions {
  onDelta: (delta: StreamDelta) => void;
  abortSignal?: AbortSignal;
}

// ─── Reasoning support ──────────────────────────────────────────────

const ANTHROPIC_BUDGET_TOKENS: Record<Exclude<ReasoningMode, "off">, number> = {
  low: 4096,
  medium: 10000,
  high: 32000,
  xhigh: 48000,
  max: 64000,
};

// ─── Helpers ─────────────────────────────────────────────────────────

function maskSecret(s: string | undefined): string {
  if (!s) return "(empty)";
  if (s.length <= 8) return "****";
  return s.slice(0, 6) + "…" + s.slice(-4);
}

const FIXED_TEMPERATURE_MODELS = new Set(["gpt-5-nano"]);

function clampTemperature(model: string, requested: number): number {
  for (const m of FIXED_TEMPERATURE_MODELS) {
    if (model.includes(m)) return 1;
  }
  return requested;
}

function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  if (raw === "stop" || raw === "end_turn") return "stop";
  if (raw === "tool_calls" || raw === "tool_use") return "tool_calls";
  if (raw === "length" || raw === "max_tokens") return "length";
  if (raw === "content_filter") return "content_filter";
  return "stop";
}

/**
 * OpenRouter (and similar gateways) can answer 200 with an error body that has
 * no `choices` — e.g. `{ error: { code: 502, message: "Provider returned an
 * empty response" } }` when the model's upstream is down. Surface that as a
 * readable error instead of a TypeError on `choices[0]`.
 */
function assertCompletionChoices(
  response: OpenAI.Chat.ChatCompletion | undefined,
): void {
  if (response?.choices?.length) return;
  const upstream = (response as any)?.error;
  const detail = upstream?.message || upstream?.code;
  throw new Error(
    detail
      ? `The model provider returned an error instead of a completion: ${detail}. The upstream model may be down — try again or pick another model.`
      : "The model provider returned a response with no completions. The upstream model may be down — try again or pick another model.",
  );
}

function extractToolCalls(
  message: OpenAI.Chat.ChatCompletionMessage,
): ToolCallData[] {
  if (!message.tool_calls?.length) return [];
  return message.tool_calls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

function logRequest(
  config: ProviderConfig,
  opts: InvokeOptions,
  streaming: boolean,
) {
  const msgCount = opts.messages.length;
  const lastRole = opts.messages[msgCount - 1]?.role ?? "?";
  const totalChars = opts.messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    return n;
  }, 0);

  console.log(
    `[inference] → provider=${config.provider} model=${config.model} auth=${config.authMethod ?? "api_key"}` +
      ` key=${maskSecret(config.authMethod === "oauth" ? config.oauthAccessToken : config.authMethod === "subscription" ? undefined : config.apiKey)}` +
      ` baseURL=${config.baseURL ?? "(default)"}` +
      ` | msgs=${msgCount} lastRole=${lastRole} chars=${totalChars}` +
      ` tools=${opts.tools?.length ?? 0} stream=${streaming}` +
      ` fmt=${opts.format ?? "text"}`,
  );
}

function logResponse(
  config: ProviderConfig,
  elapsed: number,
  result: InvokeResult,
) {
  console.log(
    `[inference] ← ${elapsed}ms provider=${config.provider} model=${result.model}` +
      ` tokens=${result.usage?.prompt_tokens ?? "?"}→${result.usage?.completion_tokens ?? "?"}` +
      ` (total ${result.usage?.total_tokens ?? "?"})` +
      ` | finish=${result.finishReason} toolCalls=${result.toolCalls.length}` +
      ` content=${result.content ? result.content.length + " chars" : "null"}`,
  );
}

function buildCompletionConfig(
  config: ProviderConfig,
  opts: InvokeOptions & { abortSignal?: AbortSignal },
  temperature: number,
  stream: boolean,
): any {
  const params: any = {
    model: config.model,
    messages: opts.messages,
    temperature,
    stream,
  };

  if (stream) {
    params.stream_options = { include_usage: true };
  }

  if (opts.tools?.length) {
    params.tools = opts.tools;
    params.tool_choice = "auto";
  }

  if (opts.reasoningMode && opts.reasoningMode !== "off") {
    if (config.provider === "kimi") {
      params.reasoning_effort = kimiReasoningEffort(opts.reasoningMode);
    } else if (config.provider === "openai") {
      params.reasoning_effort = opts.reasoningMode;
    }
  }

  if (
    opts.format === "json" &&
    !opts.tools?.length &&
    config.provider !== "anthropic"
  ) {
    params.response_format = { type: "json_object" };
  }

  return params;
}

function anthropicBlocksToResult(
  response: Anthropic.Message,
  config: ProviderConfig,
  elapsed: number,
): InvokeResult {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCallData[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      contentParts.push(block.text);
    } else if (block.type === "thinking") {
      reasoningParts.push(block.thinking);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  return {
    content: contentParts.join("") || null,
    reasoning: reasoningParts.join("") || null,
    toolCalls,
    finishReason: normalizeFinishReason(response.stop_reason),
    usage: response.usage
      ? {
          prompt_tokens: response.usage.input_tokens ?? 0,
          completion_tokens: response.usage.output_tokens ?? 0,
          total_tokens:
            (response.usage.input_tokens ?? 0) +
            (response.usage.output_tokens ?? 0),
        }
      : undefined,
    model: response.model ?? config.model,
    provider: config.provider,
    elapsedMs: elapsed,
  };
}

async function runAnthropicMessage(
  config: ProviderConfig,
  opts: InvokeOptions,
  start: number,
): Promise<InvokeResult> {
  const client = buildAnthropicClient(config);

  const response = await client.messages.create(
    buildAnthropicMessageParams({
      model: config.model,
      messages: opts.messages,
      tools: opts.tools,
      reasoningMode: opts.reasoningMode,
      enablePromptCache: true,
    }),
  );

  const elapsed = Date.now() - start;
  const result = anthropicBlocksToResult(response, config, elapsed);
  logResponse(config, elapsed, result);
  return result;
}

/**
 * Same shape as Chat Completions (`messages` + optional `tools`) so Langfuse shows a normal
 * system → user → assistant transcript instead of Responses API `input` + `instructions` in metadata.
 */
function buildLangfuseChatCompletionInput(
  opts: InvokeOptions,
): Record<string, unknown> {
  const input: Record<string, unknown> = { messages: opts.messages };
  if (opts.tools?.length) {
    input.tools = opts.tools;
    input.tool_choice = "auto";
  }
  return input;
}

function buildLangfuseResponsesOutput(params: {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCallData[];
}): unknown {
  const { content, reasoning, toolCalls } = params;
  const base: Record<string, unknown> = {
    role: "assistant",
    content: content ?? "",
  };
  if (reasoning) {
    base.reasoning_summary = reasoning;
  }
  if (toolCalls.length > 0) {
    base.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return base;
}

function usageToLangfuseDetails(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? 0,
  };
}

function getClient(config: ProviderConfig, opts: InvokeOptions): OpenAI {
  const rawClient = buildClient(config);
  if (isTracingEnabled()) {
    return observeOpenAI(rawClient, {
      sessionId: opts.sessionId,
      userId: opts.userId,
      tags: opts.tags,
      generationName: opts.generationName,
    });
  }
  return rawClient;
}

// ─── invoke_llm — non-streaming (kept for summarization, simple calls) ───

export async function resolveInvocationProvider(
  opts: Pick<InvokeOptions, "providerOverride" | "userId">,
  ownerCheck: (userId: unknown) => Promise<boolean> = isHostOwner,
  defaultProvider: () => Promise<ProviderConfig> = getProvider,
): Promise<ProviderConfig> {
  const config = opts.providerOverride ?? (await defaultProvider());
  if (
    isSubscriptionProvider(config.provider) &&
    !(await ownerCheck(opts.userId))
  ) {
    throw new Error(
      "Host CLI subscriptions are reserved for the installation owner",
    );
  }
  return config;
}

export async function invoke_llm(opts: InvokeOptions): Promise<InvokeResult> {
  const config = await resolveInvocationProvider(opts);
  const requestedTemp = clampTemperature(
    config.model,
    opts.temperature ?? 0.75,
  );
  const start = Date.now();

  logRequest(config, opts, false);

  if (isSubscriptionProvider(config.provider)) {
    const result = await invokeSubscriptionInference({
      provider: config.provider,
      model: config.model,
      reasoningMode: opts.reasoningMode ?? "off",
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
    });
    const mapped: InvokeResult = {
      ...result,
      usage: result.usage,
      provider: config.provider,
      elapsedMs: Date.now() - start,
    };
    logResponse(config, mapped.elapsedMs, mapped);
    return mapped;
  }

  if (isAnthropicApiProvider(config.provider)) {
    return await runAnthropicMessage(config, opts, start);
  }

  const client = getClient(config, opts);

  const tryCompletion = async (temp: number): Promise<InvokeResult> => {
    const params = buildCompletionConfig(config, opts, temp, false);
    const response = (await client.chat.completions.create(
      params,
    )) as OpenAI.Chat.ChatCompletion;
    assertCompletionChoices(response);
    const elapsed = Date.now() - start;
    const message = response.choices[0]?.message;

    const result: InvokeResult = {
      content: message?.content ?? null,
      reasoning: null,
      toolCalls: message ? extractToolCalls(message) : [],
      finishReason: normalizeFinishReason(response.choices[0]?.finish_reason),
      usage: response.usage,
      model: response.model ?? config.model,
      provider: config.provider,
      elapsedMs: elapsed,
    };

    logResponse(config, elapsed, result);
    return result;
  };

  try {
    return await tryCompletion(requestedTemp);
  } catch (err: any) {
    if (isTemperatureUnsupportedError(err, requestedTemp)) {
      console.warn(
        `[inference] Model ${config.model} does not support temperature=${requestedTemp}, retrying with temperature=1`,
      );
      return await tryCompletion(1);
    }

    const elapsed = Date.now() - start;
    console.error(
      `[inference] ✗ ${elapsed}ms provider=${config.provider} model=${config.model}` +
        ` | ${err?.status ?? "?"} ${err?.code ?? err?.type ?? err?.message ?? "unknown error"}`,
    );
    throw err;
  }
}

// ─── Anthropic native streaming (for extended thinking) ─────────────

/**
 * The provider pipelines are the event pumps: they translate one SDK's
 * stream into collector calls and own only what genuinely differs per
 * provider (Anthropic's usage merge, Responses' item ids, chunk-level
 * usage/model). Exported for fixture tests — internal seam, not for
 * production callers.
 */
export async function runAnthropicThinkingStream(
  client: Anthropic,
  config: ProviderConfig,
  opts: StreamingInvokeOptions,
  budgetTokens: number | null,
  start: number,
): Promise<InvokeResult> {
  const params = buildAnthropicStreamParams(
    {
      model: config.model,
      messages: opts.messages,
      tools: opts.tools,
      reasoningMode: opts.reasoningMode,
      enablePromptCache: true,
    },
    budgetTokens,
  );

  console.log(
    budgetTokens
      ? `[inference] → anthropic-native model=${config.model} thinking budget=${budgetTokens}`
      : `[inference] → anthropic-native model=${config.model}`,
  );

  const stream = client.messages.stream(params);

  const collector = createStreamCollector(opts.onDelta);
  let usage: OpenAI.Completions.CompletionUsage | undefined;

  for await (const event of stream) {
    if (opts.abortSignal?.aborted) {
      collector.setFinishReason("stop");
      break;
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as any;
      if (delta.type === "thinking_delta") collector.onReasoning(delta.thinking);
      if (delta.type === "text_delta") collector.onText(delta.text);
      if (delta.type === "input_json_delta") {
        collector.appendToolCallArgs(String(event.index), delta.partial_json);
      }
    }

    if (event.type === "content_block_start") {
      const block = (event as any).content_block;
      if (block?.type === "tool_use") {
        collector.startToolCall(String(event.index), block.id, block.name);
      }
    }

    if (event.type === "message_delta") {
      const md = event as any;
      if (md.delta?.stop_reason) {
        collector.setFinishReason(normalizeFinishReason(md.delta.stop_reason));
      }
      if (md.usage) {
        // message_delta arrives after message_start and only carries output
        // tokens; merge instead of replacing so prompt_tokens survives.
        const output = md.usage.output_tokens ?? 0;
        const prompt = usage?.prompt_tokens ?? 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: output,
          total_tokens: prompt + output,
        };
      }
    }

    if (event.type === "message_start") {
      const ms = event as any;
      if (ms.message?.usage) {
        const u = ms.message.usage;
        usage = {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        };
      }
    }
  }

  const { content, reasoning, toolCalls, finishReason } = collector.finish();

  const elapsed = Date.now() - start;
  const result: InvokeResult = {
    content,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    model: config.model,
    provider: config.provider,
    elapsedMs: elapsed,
  };

  logResponse(config, elapsed, result);
  return result;
}

// ─── OpenAI Responses API streaming (for reasoning summary) ─────────

function openaiToResponsesInput(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): { instructions: string; input: any[] } {
  let instructions = "";
  const input: any[] = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      instructions += (typeof m.content === "string" ? m.content : "") + "\n";
      continue;
    }
    if (m.role === "user") {
      input.push({
        role: "user",
        content:
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
      continue;
    }
    if (m.role === "assistant") {
      const am = m as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      if (am.tool_calls?.length) {
        if (am.content) {
          input.push({
            role: "assistant",
            content:
              typeof am.content === "string"
                ? am.content
                : JSON.stringify(am.content),
          });
        }
        for (const tc of am.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else {
        input.push({
          role: "assistant",
          content:
            typeof am.content === "string"
              ? am.content
              : JSON.stringify(am.content ?? ""),
        });
      }
      continue;
    }
    if (m.role === "tool") {
      const tm = m as OpenAI.Chat.ChatCompletionToolMessageParam;
      input.push({
        type: "function_call_output",
        call_id: tm.tool_call_id,
        output:
          typeof tm.content === "string"
            ? tm.content
            : JSON.stringify(tm.content),
      });
    }
  }

  return { instructions: instructions.trim(), input };
}

function openaiToResponsesTools(
  tools?: OpenAI.Chat.ChatCompletionTool[],
): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

export async function runOpenAIResponsesStream(
  rawClient: OpenAI,
  config: ProviderConfig,
  opts: StreamingInvokeOptions,
  reasoningMode: Exclude<ReasoningMode, "off">,
  start: number,
): Promise<InvokeResult> {
  // Raw client: observeOpenAI maps Responses API params poorly (no `messages` in trace input).
  // We record a manual generation with Chat Completions–shaped input instead.
  const { instructions, input } = openaiToResponsesInput(opts.messages);
  const responsesTools = openaiToResponsesTools(opts.tools);

  const params: any = {
    model: config.model,
    input,
    stream: true,
    reasoning: { effort: reasoningMode, summary: "auto" },
    ...(instructions ? { instructions } : {}),
    ...(responsesTools ? { tools: responsesTools, tool_choice: "auto" } : {}),
  };

  console.log(
    `[inference] → openai-responses model=${config.model} reasoning effort=${reasoningMode}`,
  );

  let generation: LangfuseGeneration | undefined;
  if (isTracingEnabled()) {
    generation = startObservation(
      opts.generationName ?? "OpenAI.responses.create",
      {
        model: config.model,
        input: buildLangfuseChatCompletionInput(opts),
        metadata: {
          api: "openai.responses",
          reasoning_effort: reasoningMode,
        },
      },
      { asType: "generation" },
    ).updateTrace({
      userId: opts.userId,
      sessionId: opts.sessionId,
      tags: opts.tags,
    });
  }

  let completionStartTime: Date | undefined;
  const endGeneration = (
    attrs: Parameters<LangfuseGeneration["update"]>[0],
  ) => {
    if (generation) {
      generation.update(attrs);
      generation.end();
      generation = undefined;
    }
  };

  const collector = createStreamCollector(opts.onDelta);
  let lastToolCallKey: string | undefined;
  let responsesToolCallCount = 0;
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  let model = config.model;

  try {
    const stream = (await rawClient.responses.create(
      params,
    )) as unknown as AsyncIterable<any>;

    for await (const event of stream) {
      if (completionStartTime === undefined) {
        completionStartTime = new Date();
      }
      if (opts.abortSignal?.aborted) {
        collector.setFinishReason("stop");
        break;
      }

      switch (event.type) {
        case "response.output_text.delta": {
          collector.onText(event.delta as string);
          break;
        }

        case "response.reasoning_summary_text.delta": {
          collector.onReasoning(event.delta as string);
          break;
        }

        case "response.output_item.added": {
          const item = event.item;
          if (item?.type === "function_call") {
            const key = item.call_id ?? item.id ?? `tc_${responsesToolCallCount++}`;
            lastToolCallKey = key;
            collector.startToolCall(key, item.call_id ?? item.id, item.name);
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const itemId = event.item_id as string;
          // A mismatched item_id falls back to the most recently started call.
          const key = collector.hasToolCall(itemId) ? itemId : lastToolCallKey;
          if (key) collector.appendToolCallArgs(key, event.delta as string);
          break;
        }

        case "response.function_call_arguments.done": {
          const itemId = event.item_id as string;
          const key = collector.hasToolCall(itemId) ? itemId : lastToolCallKey;
          if (key) collector.replaceToolCallArgs(key, event.arguments);
          break;
        }

        case "response.completed": {
          const resp = event.response;
          if (resp?.model) model = resp.model;
          if (resp?.status === "incomplete") {
            collector.setFinishReason("length");
          }
          if (resp?.usage) {
            usage = {
              prompt_tokens: resp.usage.input_tokens ?? 0,
              completion_tokens: resp.usage.output_tokens ?? 0,
              total_tokens:
                (resp.usage.input_tokens ?? 0) +
                (resp.usage.output_tokens ?? 0),
            };
          }
          break;
        }

        case "response.failed": {
          const resp = event.response;
          const errMsg = resp?.error?.message ?? "Unknown Responses API error";
          console.error(`[inference] Responses API failed: ${errMsg}`);
          throw new Error(errMsg);
        }
      }
    }

    const { content, reasoning, toolCalls, finishReason } = collector.finish();

    const elapsed = Date.now() - start;
    const result: InvokeResult = {
      content,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      model,
      provider: config.provider,
      elapsedMs: elapsed,
    };

    logResponse(config, elapsed, result);

    endGeneration({
      output: buildLangfuseResponsesOutput({
        content: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
      }),
      usageDetails: usageToLangfuseDetails(result.usage),
      model: result.model,
      completionStartTime,
    });

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    endGeneration({
      level: "ERROR",
      statusMessage: msg,
      usageDetails: usageToLangfuseDetails(usage),
      model,
    });
    throw err;
  }
}

// ─── invoke_llm_streaming — streaming with tool calls ────────────────

function kimiReasoningEffort(mode: ReasoningMode): "low" | "high" | "max" {
  return mode === "low" ? "low" : mode === "max" ? "max" : "high";
}

function isTemperatureUnsupportedError(err: any, requestedTemp: number): boolean {
  return (
    err?.code === "unsupported_value" &&
    err?.param === "temperature" &&
    requestedTemp !== 1
  );
}

/**
 * Chat-completions streaming: the event pump for every OpenAI-compatible
 * provider (openai, openrouter, ollama, kimi, gateways). Exported for fixture
 * tests — internal seam, not for production callers.
 */
export async function runChatCompletionsStream(
  client: OpenAI,
  config: ProviderConfig,
  opts: StreamingInvokeOptions,
  reasoningMode: ReasoningMode,
  temp: number,
  start: number,
): Promise<InvokeResult> {
  const params = buildCompletionConfig(config, opts, temp, true);

  if (
    reasoningMode !== "off" &&
    (config.provider === "openai-compatible" ||
      config.provider === "openrouter" ||
      config.provider === "ollama" ||
      config.provider === "kimi")
  ) {
    params.reasoning_effort =
      config.provider === "kimi"
        ? kimiReasoningEffort(reasoningMode)
        : reasoningMode;
  }

  const stream = (await client.chat.completions.create(
    params,
  )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

  const collector = createStreamCollector(opts.onDelta);
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  let model = config.model;

  for await (const chunk of stream) {
    if (opts.abortSignal?.aborted) {
      collector.setFinishReason("stop");
      break;
    }

    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage as any;

    const delta = chunk.choices?.[0]?.delta;
    const chunkFinish = chunk.choices?.[0]?.finish_reason;

    if (chunkFinish) {
      collector.setFinishReason(normalizeFinishReason(chunkFinish));
    }

    if (!delta) continue;

    const d = delta as Record<string, unknown>;
    const reasoningContent =
      (typeof d.reasoning_content === "string"
        ? d.reasoning_content
        : null) ??
      (typeof d.reasoning_text === "string" ? d.reasoning_text : null) ??
      (d.reasoning_text &&
      typeof (d.reasoning_text as { text?: string }).text === "string"
        ? (d.reasoning_text as { text: string }).text
        : null) ??
      (typeof d.reasoning === "string" ? d.reasoning : null);
    collector.onReasoning(reasoningContent ?? "");
    collector.onText(delta.content);

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const key = String(tc.index ?? 0);
        if (!collector.hasToolCall(key)) {
          collector.startToolCall(key, tc.id, tc.function?.name);
        }
        collector.updateToolCall(key, { id: tc.id, name: tc.function?.name });
        if (tc.function?.arguments) {
          collector.appendToolCallArgs(key, tc.function.arguments);
        }
      }
    }
  }

  const { content, reasoning, toolCalls, finishReason } = collector.finish();

  const elapsed = Date.now() - start;
  const result: InvokeResult = {
    content,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    model,
    provider: config.provider,
    elapsedMs: elapsed,
  };

  logResponse(config, elapsed, result);
  return result;
}

export async function invoke_llm_streaming(
  opts: StreamingInvokeOptions,
): Promise<InvokeResult> {
  const config = await resolveInvocationProvider(opts);
  const reasoningMode = opts.reasoningMode ?? "off";
  const start = Date.now();

  if (isSubscriptionProvider(config.provider)) {
    logRequest(config, opts, true);
    const result = await invokeSubscriptionInference({
      provider: config.provider,
      model: config.model,
      reasoningMode,
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
      abortSignal: opts.abortSignal,
    });
    if (result.reasoning) {
      opts.onDelta({ type: "reasoning", content: result.reasoning });
    }
    if (result.content) {
      opts.onDelta({ type: "text", content: result.content });
    }
    result.toolCalls.forEach((toolCall, index) => {
      opts.onDelta({
        type: "tool_call_start",
        toolCall: { index, id: toolCall.id, name: toolCall.name },
      });
      opts.onDelta({
        type: "tool_call_done",
        toolCall: { index, ...toolCall },
      });
    });
    const mapped: InvokeResult = {
      ...result,
      usage: result.usage,
      provider: config.provider,
      elapsedMs: Date.now() - start,
    };
    logResponse(config, mapped.elapsedMs, mapped);
    return mapped;
  }

  if (isAnthropicApiProvider(config.provider)) {
    const budget =
      reasoningMode !== "off" ? ANTHROPIC_BUDGET_TOKENS[reasoningMode] : null;
    logRequest(config, opts, true);
    return await runAnthropicThinkingStream(
      buildAnthropicClient(config),
      config,
      opts,
      budget,
      start,
    );
  }

  if (reasoningMode !== "off" && config.provider === "openai") {
    logRequest(config, opts, true);
    return await runOpenAIResponsesStream(
      buildClient(config),
      config,
      opts,
      reasoningMode,
      start,
    );
  }

  const client = getClient(config, opts);
  const requestedTemp = clampTemperature(
    config.model,
    opts.temperature ?? 0.75,
  );

  logRequest(config, opts, true);

  try {
    return await runChatCompletionsStream(
      client,
      config,
      opts,
      reasoningMode,
      requestedTemp,
      start,
    );
  } catch (err: any) {
    if (isTemperatureUnsupportedError(err, requestedTemp)) {
      console.warn(`[inference] Retrying stream with temperature=1`);
      return await runChatCompletionsStream(
        client,
        config,
        opts,
        reasoningMode,
        1,
        start,
      );
    }

    const isToolsUnsupported =
      opts.tools?.length &&
      (err?.message?.includes("tool") || err?.code === "unsupported_parameter");

    if (isToolsUnsupported) {
      console.warn(
        `[inference] Provider does not support native tool calling, falling back to JSON-in-prompt`,
      );
      return await invoke_llm_json_fallback(opts, config, start);
    }

    const elapsed = Date.now() - start;
    console.error(
      `[inference] ✗ ${elapsed}ms stream provider=${config.provider} model=${config.model}` +
        ` | ${err?.status ?? "?"} ${err?.code ?? err?.type ?? err?.message ?? "unknown error"}`,
    );
    throw err;
  }
}

// ─── JSON-in-prompt fallback for providers without native tool calling ───

function buildToolDescriptionPrompt(
  tools: OpenAI.Chat.ChatCompletionTool[],
): string {
  const descriptions = tools
    .map((t) => {
      const fn = t.function;
      return `- **${fn.name}**: ${fn.description}\n  Parameters: ${JSON.stringify(fn.parameters)}`;
    })
    .join("\n");

  return `You have access to the following tools. To use a tool, respond with a JSON object containing "tool_calls" array. Each element should have "name" (tool name) and "arguments" (object with the tool parameters). If you don't need to use a tool, respond normally without the tool_calls field.

Available tools:
${descriptions}

When using tools, respond ONLY with this JSON format:
{"content": "your thinking/explanation", "tool_calls": [{"name": "tool_name", "arguments": {...}}]}

When NOT using tools, respond with plain text.`;
}

async function invoke_llm_json_fallback(
  opts: StreamingInvokeOptions,
  config: ProviderConfig,
  startTime: number,
): Promise<InvokeResult> {
  const client = getClient(config, opts);

  const messages = [...opts.messages];
  if (opts.tools?.length) {
    const toolPrompt = buildToolDescriptionPrompt(opts.tools);
    const sysIdx = messages.findIndex((m) => m.role === "system");
    if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
      messages[sysIdx] = {
        ...messages[sysIdx],
        content: (messages[sysIdx] as any).content + "\n\n" + toolPrompt,
      };
    } else {
      messages.unshift({ role: "system", content: toolPrompt });
    }
  }

  const params: any = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0.75,
  };

  const response = (await client.chat.completions.create(
    params,
  )) as OpenAI.Chat.ChatCompletion;
  assertCompletionChoices(response);
  const elapsed = Date.now() - startTime;
  const rawContent = response.choices[0]?.message?.content ?? "";

  let content: string | null = rawContent;
  let toolCalls: ToolCallData[] = [];
  let finishReason: FinishReason = "stop";

  try {
    const parsed = JSON.parse(rawContent);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      content = parsed.content || null;
      toolCalls = parsed.tool_calls.map((tc: any, i: number) => ({
        id: `fallback_${Date.now()}_${i}`,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments ?? {}),
      }));
      finishReason = "tool_calls";
    }
  } catch {
    // Not JSON, treat as plain text
  }

  if (content) opts.onDelta({ type: "text", content });
  for (const tc of toolCalls) {
    opts.onDelta({ type: "tool_call_start", toolCall: tc });
    opts.onDelta({ type: "tool_call_done", toolCall: tc });
  }

  const result: InvokeResult = {
    content,
    reasoning: null,
    toolCalls,
    finishReason,
    usage: response.usage,
    model: response.model ?? config.model,
    provider: config.provider,
    elapsedMs: elapsed,
  };

  logResponse(config, elapsed, result);
  return result;
}
