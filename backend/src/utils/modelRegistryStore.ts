import fs from "fs";
import path from "path";
import { deleteEnvVars, readEnvFile } from "./envWriter";
import { getDataDir } from "./loadConfig";
import {
  ModelReasoningMode,
  normalizeModelId,
} from "./modelMetadata";

export type { ModelReasoningMode } from "./modelMetadata";

export interface ModelPreset {
  id: string;
  label: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  reasoningMode?: ModelReasoningMode;
  verifiedAt?: string;
}

export interface ModelAssignments {
  orchestratorModelId?: string;
  browserModelId?: string;
}

export interface ModelRegistry {
  models: ModelPreset[];
  assignments: ModelAssignments;
}

const LEGACY_MODEL_KEYS = [
  "MODEL_PRESETS_JSON",
  "MODEL_ASSIGNMENTS_JSON",
  "ORCHESTRATOR_NAME",
  "ORCHESTRATOR_PROVIDER",
  "ORCHESTRATOR_MODEL",
  "ORCHESTRATOR_API_KEY",
  "ORCHESTRATOR_BASE_URL",
  "ORCHESTRATOR_REASONING_MODE",
  "MAGNITUDE_MODEL_PROVIDER",
  "MAGNITUDE_MODEL",
  "MAGNITUDE_MODEL_API_KEY",
  "MAGNITUDE_MODEL_BASE_URL",
  ...Array.from({ length: 8 }, (_, i) => i + 1).flatMap((_idx) => [
  ]),
];

const VALID_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "anthropic-compatible",
  "openrouter",
  "google",
  "mistralai",
  "ollama",
  "openai-compatible",
  "kimi",
  "minimax",
  "bedrock",
  "codex-subscription",
  "claude-subscription",
]);

const VALID_REASONING = new Set([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredModelId(model: unknown): string {
  const trimmed = asString(model);
  return normalizeModelId(trimmed);
}

function normalizeReasoning(value: unknown): ModelReasoningMode {
  const mode = asString(value).toLowerCase();
  return (VALID_REASONING.has(mode) ? mode : "off") as ModelReasoningMode;
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;

  const candidates = [
    value,
    value.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "string") {
        return JSON.parse(parsed) as T;
      }
      return parsed as T;
    } catch {
      // Try the next representation. Some .env values are stored as escaped
      // JSON strings because the env writer quotes every value.
    }
  }

  return fallback;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function createId(label: string, used: Set<string>): string {
  const base = slugify(label) || "model";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

function sanitizePreset(
  raw: Partial<ModelPreset>,
  usedIds: Set<string>,
): ModelPreset | null {
  const label = asString(raw.label);
  const provider = asString(raw.provider);
  const model = normalizeStoredModelId(raw.model);
  if (!label || !VALID_PROVIDERS.has(provider) || !model) {
    // Dropping silently makes a preset simply vanish from Settings, and any
    // assignment pointing at it falls back to another model with no
    // explanation. Say why — an unknown provider here is usually a new
    // ProviderType that was never added to VALID_PROVIDERS.
    console.warn(
      `[modelRegistry] Ignoring preset ${JSON.stringify(asString(raw.id) || label || "(unnamed)")}: ` +
        `${!label ? "missing label" : !VALID_PROVIDERS.has(provider) ? `unknown provider "${provider}"` : "missing model"}`,
    );
    return null;
  }

  const requestedId = slugify(asString(raw.id));
  const id =
    requestedId && !usedIds.has(requestedId)
      ? requestedId
      : createId(label, usedIds);
  usedIds.add(id);

  return {
    id,
    label,
    provider,
    model,
    apiKey: asString(raw.apiKey) || undefined,
    baseURL: asString(raw.baseURL) || undefined,
    reasoningMode: normalizeReasoning(raw.reasoningMode),
    verifiedAt: asString(raw.verifiedAt) || undefined,
  };
}

/**
 * Validate assignments against the model list. With `strict` (the write path)
 * an unknown non-empty id is an error instead of a silent fallback — silently
 * remapping to models[0] would answer 200 with different assignments than
 * requested. The lenient fallback remains for env-var migration and stored
 * profiles that may reference a since-removed model.
 */
function sanitizeAssignments(
  raw: Partial<ModelAssignments>,
  models: ModelPreset[],
  strict = false,
): ModelAssignments {
  const ids = new Set(models.map((model) => model.id));
  const orchestratorModelId = asString(raw.orchestratorModelId);
  const browserModelId = asString(raw.browserModelId);
  if (strict && orchestratorModelId && !ids.has(orchestratorModelId)) {
    throw new Error(`orchestratorModelId "${orchestratorModelId}" does not match any model in the list`);
  }
  if (strict && browserModelId && !ids.has(browserModelId)) {
    throw new Error(`browserModelId "${browserModelId}" does not match any model in the list`);
  }
  return {
    orchestratorModelId: ids.has(orchestratorModelId)
      ? orchestratorModelId
      : models[0]?.id,
    browserModelId: ids.has(browserModelId) ? browserModelId : undefined,
  };
}

function legacyPresetKey(
  preset: Pick<ModelPreset, "provider" | "model" | "apiKey" | "baseURL">,
): string {
  return [
    preset.provider,
    preset.model,
    preset.apiKey || "",
    preset.baseURL || "",
  ].join("\u0000");
}

function addLegacyPreset(
  models: ModelPreset[],
  usedIds: Set<string>,
  dedupe: Map<string, string>,
  raw: Omit<ModelPreset, "id">,
): string | null {
  const preset = sanitizePreset({ ...raw }, usedIds);
  if (!preset) return null;

  const key = legacyPresetKey(preset);
  const existingId = dedupe.get(key);
  if (existingId) return existingId;

  models.push(preset);
  dedupe.set(key, preset.id);
  return preset.id;
}

function hasLegacyModelConfig(env: Record<string, string>): boolean {
  return Boolean(
    env.ORCHESTRATOR_PROVIDER ||
    env.ORCHESTRATOR_MODEL ||
    env.ORCHESTRATOR_API_KEY ||
    env.MAGNITUDE_MODEL_PROVIDER ||
    env.MAGNITUDE_MODEL ||
    env.MAGNITUDE_MODEL_API_KEY,
  );
}

function migrateLegacyModelConfig(env: Record<string, string>): ModelRegistry {
  const models: ModelPreset[] = [];
  const assignments: ModelAssignments = {};
  const usedIds = new Set<string>();
  const dedupe = new Map<string, string>();

  const orchestratorId = addLegacyPreset(models, usedIds, dedupe, {
    label: asString(env.ORCHESTRATOR_NAME) || "Orchestrator",
    provider: asString(env.ORCHESTRATOR_PROVIDER),
    model: normalizeStoredModelId(env.ORCHESTRATOR_MODEL),
    apiKey: asString(env.ORCHESTRATOR_API_KEY) || undefined,
    baseURL: asString(env.ORCHESTRATOR_BASE_URL) || undefined,
    reasoningMode: normalizeReasoning(env.ORCHESTRATOR_REASONING_MODE),
  });
  if (orchestratorId) assignments.orchestratorModelId = orchestratorId;


  const browserId = addLegacyPreset(models, usedIds, dedupe, {
    label: "Browser Agent",
    provider: asString(env.MAGNITUDE_MODEL_PROVIDER),
    model: normalizeStoredModelId(env.MAGNITUDE_MODEL),
    apiKey: asString(env.MAGNITUDE_MODEL_API_KEY) || undefined,
    baseURL: asString(env.MAGNITUDE_MODEL_BASE_URL) || undefined,
    reasoningMode: "off",
  });
  if (browserId) assignments.browserModelId = browserId;

  if (!assignments.orchestratorModelId && models[0]) {
    assignments.orchestratorModelId = models[0].id;
  }

  return { models, assignments: sanitizeAssignments(assignments, models) };
}

export function getModelRegistryPath(): string {
  return path.join(getDataDir(), "model-registry.json");
}

function emptyRegistry(): ModelRegistry {
  return { models: [], assignments: {} };
}

function readProfileRegistry(): ModelRegistry | null {
  const profilePath = getModelRegistryPath();
  if (!fs.existsSync(profilePath)) return null;

  try {
    const raw = fs.readFileSync(profilePath, "utf-8");
    if (!raw.trim()) return emptyRegistry();
    const parsed = JSON.parse(raw) as Partial<ModelRegistry>;
    return normalizeModelRegistryInput(
      Array.isArray(parsed.models) ? parsed.models : [],
      parsed.assignments || {},
    );
  } catch (error) {
    console.warn("[modelRegistry] Failed to parse model registry profile:", error);
    return emptyRegistry();
  }
}

function writeProfileRegistry(registry: ModelRegistry): void {
  const profilePath = getModelRegistryPath();
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  // Write in place instead of write-tmp + rename. model-registry.json is often
  // bind-mounted as an individual file, and renaming over a bind-mount
  // mountpoint fails with EBUSY (Docker Desktop on macOS, and Linux when the
  // destination is the mount itself). writeFileSync rewrites the existing inode.
  fs.writeFileSync(
    profilePath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

function registryFromEnvJson(env: Record<string, string>): ModelRegistry {
  const usedIds = new Set<string>();
  const models = parseJson<Partial<ModelPreset>[]>(env.MODEL_PRESETS_JSON, [])
    .map((preset) => sanitizePreset(preset, usedIds))
    .filter((preset): preset is ModelPreset => Boolean(preset));
  const assignments = sanitizeAssignments(
    parseJson<Partial<ModelAssignments>>(env.MODEL_ASSIGNMENTS_JSON, {}),
    models,
  );
  return { models, assignments };
}

function hasEnvJsonRegistry(env: Record<string, string>): boolean {
  return Boolean(env.MODEL_PRESETS_JSON || env.MODEL_ASSIGNMENTS_JSON);
}

function migrateEnvRegistryIfPresent(env: Record<string, string>): ModelRegistry | null {
  if (hasEnvJsonRegistry(env)) {
    const migrated = registryFromEnvJson(env);
    writeProfileRegistry(migrated);
    deleteEnvVars(LEGACY_MODEL_KEYS);
    return migrated;
  }

  if (hasLegacyModelConfig(env)) {
    const migrated = migrateLegacyModelConfig(env);
    writeProfileRegistry(migrated);
    deleteEnvVars(LEGACY_MODEL_KEYS);
    return migrated;
  }

  return null;
}

export function readModelRegistry(): ModelRegistry {
  const env = readEnvFile();
  const profile = readProfileRegistry();
  if (
    profile &&
    (profile.models.length > 0 ||
      (!hasEnvJsonRegistry(env) && !hasLegacyModelConfig(env)))
  ) {
    return profile;
  }

  const migrated = migrateEnvRegistryIfPresent(env);
  if (migrated) return migrated;

  return profile || emptyRegistry();
}

export function writeModelRegistry(
  modelsInput: Partial<ModelPreset>[],
  assignmentsInput: Partial<ModelAssignments>,
  blankLegacy = true,
): ModelRegistry {
  const { models, assignments } = normalizeModelRegistryInput(
    modelsInput,
    assignmentsInput,
  );
  const registry = { models, assignments };
  writeProfileRegistry(registry);
  if (blankLegacy) deleteEnvVars(LEGACY_MODEL_KEYS);
  return registry;
}

export function normalizeModelRegistryInput(
  modelsInput: Partial<ModelPreset>[],
  assignmentsInput: Partial<ModelAssignments>,
): ModelRegistry {
  const usedIds = new Set<string>();
  const models = modelsInput
    .map((preset) => sanitizePreset(preset, usedIds))
    .filter((preset): preset is ModelPreset => Boolean(preset));
  const assignments = sanitizeAssignments(assignmentsInput, models, true);
  return { models, assignments };
}

export function resolveAssignedModel(
  registry: ModelRegistry,
  id: string | undefined,
): ModelPreset | null {
  if (!id) return null;
  return registry.models.find((model) => model.id === id) || null;
}

export function getAssignedModels(): {
  orchestrator: ModelPreset | null;
  browser: ModelPreset | null;
  all: ModelPreset[];
  assignments: ModelAssignments;
} {
  const registry = readModelRegistry();
  return {
    orchestrator: resolveAssignedModel(
      registry,
      registry.assignments.orchestratorModelId,
    ),
    browser: resolveAssignedModel(
      registry,
      registry.assignments.browserModelId,
    ),
    all: registry.models,
    assignments: registry.assignments,
  };
}
