import { getAssignedModels, ModelPreset } from "../modelRegistryStore";
import { normalizeModelId } from "../modelMetadata";
import { isHostOwner } from "../../services/host-owner.service";
import { isSubscriptionProvider } from "../../services/subscription-inference.service";
import { maybeRefreshOAuthToken } from "./provider-config";
import { updateEnvVars } from "../envWriter";
import type { ProviderConfig, ProviderType, ReasoningMode } from "./types";

// ─── Orchestrator resolution ─────────────────────────────────────────
// Every "which model config do we invoke with" question lives here: the
// assigned orchestrator (verified, host-owner-restricted) or the env
// default, the 30s provider cache behind the env default, and the
// per-invocation override + subscription-owner guard. The invoke and
// streaming modules call these verbs; they never re-derive the fallback
// chain, the verification check, or the reasoning-mode cast.

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

/**
 * The one way provider-relevant env changes land: write the .env file AND
 * drop the provider cache, so a later getProvider() never serves a config
 * built from the pre-update env. Callers that only change non-provider
 * values (SSH, Burp RPC) may still use updateEnvVars directly.
 */
export function applyEnvUpdates(updates: Record<string, string>): void {
  updateEnvVars(updates);
  clearProviderCache();
}

// ─── Per-user model config ───────────────────────────────────────────

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
        contextWindow: preset.contextWindow,
        maxOutputTokens: preset.maxOutputTokens,
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
    contextWindow: preset.contextWindow,
    maxOutputTokens: preset.maxOutputTokens,
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

/**
 * The per-invocation half of resolution: an explicit override wins; the
 * global default does not. Subscription providers refuse non-owners here,
 * before any request is built.
 */
export async function resolveInvocationProvider(
  opts: { providerOverride?: ProviderConfig; userId?: string },
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
