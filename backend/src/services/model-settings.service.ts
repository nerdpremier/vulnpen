import {
  ModelAssignments,
  ModelPreset,
  ModelReasoningMode,
  ModelRegistry,
  VALID_PROVIDERS,
  VALID_REASONING,
  normalizeModelRegistryInput,
  readModelRegistry,
  rewriteDockerHostBaseURL,
  slugify,
  writeModelRegistry,
} from "../utils/modelRegistryStore";
import {
  clearProviderCache,
  presetToProviderConfig,
} from "../utils/llm/orchestrator";
import { invoke_llm } from "../utils/llm/invoke";
import {
  invokeSubscriptionInference,
  isSubscriptionProvider,
} from "./subscription-inference.service";
import { readEnvFile } from "../utils/envWriter";

// ─── Model settings ─────────────────────────────────────────────────
// Every mutation of the model registry lives here: the Settings → Models
// save, the legacy orchestrator upsert, assignment changes, the
// subscription connect, and the verification stamp. Each verb restores
// masked api keys, applies the verify-on-change rule, and commits through
// commitRegistry — the one place that writes the registry AND clears the
// orchestrator's provider cache. Handlers never call writeModelRegistry
// directly (a write without the cache clear serves a stale orchestrator
// for up to 30s) and never re-derive the masked-key restore.

/**
 * Probe a preset so it can be saved as verified: subscription providers
 * round-trip their CLI, everyone else gets a one-shot inference with a
 * 45s timeout. Returns the verifiedAt timestamp to stamp.
 */
export async function verifyModelPreset(model: ModelPreset): Promise<string> {
  if (isSubscriptionProvider(model.provider)) {
    await invokeSubscriptionInference({
      provider: model.provider,
      model: model.model,
      reasoningMode: "off",
      messages: [{ role: "user", content: "Reply with exactly: connected" }],
      format: "text",
    });
    return new Date().toISOString();
  }

  // A loopback base URL was already rewritten to the Docker host alias by the
  // registry normalizer, so a preset that reached here through saveModels
  // already points where the container can dial it. Normalizing again keeps a
  // caller that bypasses the registry probing that same address instead of the
  // container's own loopback.
  const config = await presetToProviderConfig({
    ...model,
    baseURL: rewriteDockerHostBaseURL(model.baseURL ?? "") || undefined,
  });
  if (!config.apiKey && config.authMethod !== "oauth" && config.provider !== "ollama") {
    throw new Error("API key is required");
  }

  await Promise.race([
    invoke_llm({
      messages: [{ role: "user", content: "Reply with exactly: connected" }],
      temperature: 0,
      reasoningMode: "off",
      providerOverride: config,
      generationName: "model-setup-test",
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Model inference test timed out after 45 seconds")), 45_000),
    ),
  ]);
  return new Date().toISOString();
}

/**
 * The masked key the client sends back is display output, not a secret. The
 * literal bullet is not the only shape a mask has taken historically — an
 * earlier build emitted double-decoded bytes instead — so match the mask by
 * "starts and ends with a short key-shaped prefix/suffix around a long run of
 * non-ASCII filler" rather than a single character. Getting this wrong is not
 * cosmetic: an unrecognized mask is forwarded to the provider verbatim and
 * fails the save with an opaque transport error.
 */
function isMaskedApiKey(apiKey: unknown): apiKey is string {
  if (typeof apiKey !== "string") return false;
  if (apiKey.includes("•")) return true;
  return /^[\x21-\x7e]{1,6}[^\x00-\x7f|\s]{6,}[\x21-\x7e]{1,6}$/.test(apiKey);
}

/**
 * Swap client-masked api keys (`sk-1••••••••wxyz`) for the saved secret.
 * Must run on the raw input before normalization drops the id it came in
 * under — duplicate ids would make the sanitizer rename one preset and the
 * restore would then re-key the wrong one, which is why saveModels rejects
 * duplicates outright instead.
 */
function restoreMaskedApiKeys(
  models: Partial<ModelPreset>[],
  existingById: Map<string, ModelPreset>,
): Partial<ModelPreset>[] {
  return models.map((model) => {
    if (!isMaskedApiKey(model.apiKey)) return model;
    const saved = existingById.get(typeof model.id === "string" ? model.id : "");
    return { ...model, apiKey: saved?.apiKey };
  });
}

/** A preset counts as changed when any credential-bearing field moved. */
function presetChanged(saved: ModelPreset | undefined, model: ModelPreset): boolean {
  return !saved ||
    saved.provider !== model.provider ||
    saved.model !== model.model ||
    (saved.apiKey || "") !== (model.apiKey || "") ||
    (saved.baseURL || "") !== (model.baseURL || "");
}

function commitRegistry(
  models: Partial<ModelPreset>[],
  assignments: Partial<ModelAssignments>,
): ModelRegistry {
  const registry = writeModelRegistry(models, assignments);
  clearProviderCache();
  return registry;
}

export interface SaveModelsDeps {
  verify?: (model: ModelPreset) => Promise<string>;
}

/**
 * The Settings → Models save: normalize the whole list, restore masked
 * secrets, re-verify every preset that changed (or that is assigned while
 * still unverified), then commit. Throws on duplicate ids and on presets
 * the normalizer would silently drop — the caller surfaces the message.
 */
export async function saveModels(
  modelsInput: Partial<ModelPreset>[],
  assignmentsInput: Partial<ModelAssignments>,
  deps: SaveModelsDeps = {},
): Promise<ModelRegistry> {
  const verify = deps.verify ?? verifyModelPreset;

  const requestedIds = new Set<string>();
  for (const model of modelsInput) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id) {
      throw new Error("Each model must have an id");
    }
    if (requestedIds.has(id)) {
      throw new Error(`Duplicate model id "${id}"`);
    }
    requestedIds.add(id);
  }

  const normalized = normalizeOnce(modelsInput, assignmentsInput);
  if (modelsInput.length > 0 && normalized.models.length !== modelsInput.length) {
    throw new Error(
      "Each model must have id, label, valid provider, and model fields",
    );
  }

  const existing = readModelRegistry();
  const existingById = new Map(existing.models.map((model) => [model.id, model]));
  const restored = normalizeOnce(
    restoreMaskedApiKeys(modelsInput, existingById),
    assignmentsInput,
  );

  const assignedIds = new Set([
    restored.assignments.orchestratorModelId,
    restored.assignments.browserModelId,
  ].filter(Boolean));
  const verifiedModels = [];
  for (const model of restored.models) {
    const saved = existingById.get(model.id);
    const mustVerify = presetChanged(saved, model) ||
      (assignedIds.has(model.id) && !saved?.verifiedAt);
    verifiedModels.push({
      ...model,
      verifiedAt: mustVerify ? await verify(model) : saved?.verifiedAt,
    });
  }

  return commitRegistry(verifiedModels, restored.assignments);
}

function normalizeOnce(
  modelsInput: Partial<ModelPreset>[],
  assignmentsInput: Partial<ModelAssignments>,
): ModelRegistry {
  return normalizeModelRegistryInput(modelsInput, assignmentsInput);
}

/**
 * The legacy single-orchestrator save: upsert one preset under the current
 * assignment's id (or a provider-model slug when none is assigned) and
 * point the orchestrator at it. An unchanged preset keeps its verifiedAt —
 * overwriting it would leave the installation without a runnable
 * orchestrator until the next manual verification.
 */
export async function assignOrchestratorPreset(
  input: Partial<ModelPreset>,
): Promise<ModelRegistry> {
  const provider = typeof input.provider === "string" ? input.provider : "";
  const model = typeof input.model === "string" ? input.model : "";
  if (!provider || !model) {
    throw new Error("Provider and model are required");
  }

  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Invalid provider. Must be one of: ${Array.from(VALID_PROVIDERS).join(", ")}`,
    );
  }

  const reasoningMode = input.reasoningMode as string | undefined;
  if (reasoningMode && !VALID_REASONING.has(reasoningMode)) {
    throw new Error(
      `Invalid reasoning mode. Must be one of: ${Array.from(VALID_REASONING).join(", ")}`,
    );
  }

  const registry = readModelRegistry();
  const existingId =
    registry.assignments.orchestratorModelId ||
    slugify(`${provider}-${model}`);
  const existing = registry.models.find((entry) => entry.id === existingId);

  const apiKey = input.apiKey;
  if (
    !apiKey &&
    !(provider === "anthropic" && !!readEnvFile().ANTHROPIC_OAUTH_ACCESS_TOKEN) &&
    provider !== "ollama" &&
    !isSubscriptionProvider(provider)
  ) {
    throw new Error("API key is required");
  }

  const entry: Partial<ModelPreset> = {
    id: existingId,
    label: (typeof input.label === "string" && input.label) || existing?.label || "Orchestrator",
    provider,
    model,
    apiKey: isMaskedApiKey(apiKey) ? existing?.apiKey : apiKey || "",
    baseURL: input.baseURL || "",
    reasoningMode: (reasoningMode || "off") as ModelReasoningMode,
  };
  const models = existing
    ? registry.models.map((item) => (item.id === existingId ? entry : item))
    : [...registry.models, entry];

  // Preserve the stamp when nothing credential-bearing moved; a real
  // change drops it so the orchestrator refuses to run unverified.
  const restored = normalizeOnce([entry], {});
  const unchanged = existing && !presetChanged(existing, restored.models[0]);
  const stamped = unchanged ? { ...entry, verifiedAt: existing.verifiedAt } : entry;

  return commitRegistry(
    models.map((item) => (item.id === existingId ? stamped : item)),
    { ...registry.assignments, orchestratorModelId: existingId },
  );
}

/** Reset the orchestrator assignment (falls back to the first model). */
export function clearOrchestratorAssignment(): ModelRegistry {
  const registry = readModelRegistry();
  return commitRegistry(registry.models, {
    ...registry.assignments,
    orchestratorModelId: undefined,
  });
}

/** Assign (or clear, with "") the Browser Agent model. */
export function setBrowserModel(modelId: string | undefined): ModelRegistry {
  const registry = readModelRegistry();
  return commitRegistry(registry.models, {
    ...registry.assignments,
    browserModelId: modelId || undefined,
  });
}

/**
 * Connect a host CLI subscription as a preset: find-or-create by
 * provider+model, optionally taking over the orchestrator assignment when
 * none is set (or the caller explicitly asks). The id is slugified the way
 * the store will normalize it, so the assignment written in the same
 * commit passes the strict id check.
 */
export function connectSubscriptionPreset(opts: {
  provider: string;
  model: string;
  label?: unknown;
  reasoningMode?: unknown;
  assignOrchestrator?: boolean;
}): { registry: ModelRegistry; presetId: string } {
  const registry = readModelRegistry();
  const existing = registry.models.find(
    (entry) => entry.provider === opts.provider && entry.model === opts.model,
  );
  const presetId = existing?.id || slugify(`${opts.provider}-${opts.model}`);

  const label =
    String(opts.label || "") ||
    (opts.provider === "codex-subscription"
      ? `Codex · ${opts.model}`
      : `Claude Code · ${opts.model}`);
  const preset = {
    id: presetId,
    label,
    provider: opts.provider,
    model: opts.model,
    reasoningMode: ((opts.reasoningMode as string) || "high") as ModelReasoningMode,
  };
  const models = existing
    ? registry.models.map((entry) => (entry.id === presetId ? preset : entry))
    : [...registry.models, preset];
  const assignments = {
    ...registry.assignments,
    orchestratorModelId:
      opts.assignOrchestrator || !registry.assignments.orchestratorModelId
        ? presetId
        : registry.assignments.orchestratorModelId,
  };

  const updated = commitRegistry(models, assignments);
  return { registry: updated, presetId };
}

/** Stamp verifiedAt on every preset matching provider+model. */
export function markPresetVerified(
  provider: string,
  model: string,
): ModelRegistry {
  const registry = readModelRegistry();
  const verifiedAt = new Date().toISOString();
  return commitRegistry(
    registry.models.map((entry) =>
      entry.provider === provider && entry.model === model
        ? { ...entry, verifiedAt }
        : entry,
    ),
    registry.assignments,
  );
}
