import { Response, Request } from "express";
import crypto from "crypto";
import { formatMagnitudeError } from "../utils/magnitudeError";
import axios from "axios";
import {
  getBrowserAgentDisplay,
  getBrowserAgentRfbPort,
  getBrowserAgentNovncPort,
} from "../config/constants";
import { isPortListening } from "../utils/tcpProbe";
import { getAvailableModels as fetchModelsCatalog } from "../services/models-catalog.service";
import {
  clearProviderCache,
  invoke_llm,
  presetToProviderConfig,
} from "../utils/llm/providers";
import {
  getSubscriptionProviderStatuses,
  invokeSubscriptionInference,
  isSubscriptionProvider,
} from "../services/subscription-inference.service";
import { resolveMagnitudeLlmConfig } from "../utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  runBrowserAgentExclusive,
  scheduleBrowserAgentIdleStop,
  stopBrowserAgent,
} from "../services/browser-agent.service";
import { requireActiveSession } from "../services/session.helpers";
import {
  getVncConfig,
  updateVncConfig,
  resetVncConfig,
  provisionVnc,
  runDiagnostics,
  repairVnc as repairVncSession,
} from "../services/vnc-provisioning.service";
import {
  getAssignedModels,
  normalizeModelRegistryInput,
  readModelRegistry,
  writeModelRegistry,
} from "../utils/modelRegistryStore";
import { isHostOwner } from "../services/host-owner.service";
import { resolveToolExecutionMode } from "../models/User/User.model";

export const updateUserProfile = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Invalid name",
      });
    }

    user.name = name;

    await user.save();

    return res.status(200).json({
      message: "User profile updated",
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({
      message: "Failed to update user profile",
    });
  }
};

export const updateUserProfileImage = async (req: Request, res: Response) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        message: "Invalid file",
      });
    }

    if (file.size > 2097152) {
      return res.status(400).json({ message: "file size is too large" });
    }

    return res.status(200).json({
      message: "User profile image updated",
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({
      message: "Failed to update user profile image",
    });
  }
};

// Tools

export const updateToolsPreference = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const { tools } = req.body;

    if (!tools) {
      return res.status(400).json({
        message: "Invalid data",
      });
    }

    user.configs.tools = tools;

    await user.save();

    return res.status(200).json({
      message: "Tools preference updated",
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({
      message: "Failed to update user profile",
    });
  }
};

export const getUserTools = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    return res.status(200).json({ tools: user.configs.tools });
  } catch (error) {
    console.log(error);
    return res.status(400).json({
      message: "Failed to get user tools",
    });
  }
};

// ─── Agent Tools Toggle ─────────────────────────────────────────────

import { toolRegistry } from "../tools/registry";
import {
  DEFAULT_MAX_AGENT_ITERATIONS,
  MAX_MAX_AGENT_ITERATIONS,
  MIN_MAX_AGENT_ITERATIONS,
  normalizeMaxAgentIterations,
} from "../utils/agentConfig";

export const getAgentToolsConfig = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const disabledTools: string[] = user.configs.disabledAgentTools || [];

    const allTools = toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      enabled: !disabledTools.includes(t.name),
    }));

    return res.status(200).json({ tools: allTools });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to get agent tools config" });
  }
};

export const updateAgentToolsConfig = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const { disabledTools } = req.body;

    if (!Array.isArray(disabledTools)) {
      return res
        .status(400)
        .json({ message: "disabledTools must be an array" });
    }

    user.configs.disabledAgentTools = disabledTools;
    await user.save();

    return res.status(200).json({ message: "Agent tools config updated" });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to update agent tools config" });
  }
};

// ─── Agent Behavior ─────────────────────────────────────────────────

export const getAgentBehaviorConfig = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    return res.status(200).json({
      maxAgentIterations: normalizeMaxAgentIterations(
        user.configs.maxAgentIterations ?? DEFAULT_MAX_AGENT_ITERATIONS,
      ),
      minMaxAgentIterations: MIN_MAX_AGENT_ITERATIONS,
      maxMaxAgentIterations: MAX_MAX_AGENT_ITERATIONS,
    });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to get agent behavior config" });
  }
};

export const updateAgentBehaviorConfig = async (
  req: Request,
  res: Response,
) => {
  try {
    const rawValue = req.body?.maxAgentIterations;
    const parsed = Number(rawValue);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_MAX_AGENT_ITERATIONS ||
      parsed > MAX_MAX_AGENT_ITERATIONS
    ) {
      return res.status(400).json({
        message: `maxAgentIterations must be an integer between ${MIN_MAX_AGENT_ITERATIONS} and ${MAX_MAX_AGENT_ITERATIONS}`,
      });
    }

    const user = res.locals.user;
    user.configs.maxAgentIterations = parsed;
    await user.save();

    return res.status(200).json({
      message: "Agent behavior updated",
      maxAgentIterations: parsed,
    });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to update agent behavior config" });
  }
};

// ─── Unified Models ──────────────────────────────────────────────────

function modelForClient(model: any) {
  return {
    ...model,
    apiKey: model.apiKey
      ? `${model.apiKey.slice(0, 4)}${"•".repeat(8)}${model.apiKey.slice(-4)}`
      : undefined,
    hasApiKey: Boolean(model.apiKey),
  };
}

async function verifyModelPreset(model: any): Promise<string> {
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

  if (
    process.env.VULNPEN_DOCKER === "1" &&
    model.baseURL &&
    ["localhost", "127.0.0.1", "::1"].includes(new URL(model.baseURL).hostname)
  ) {
    throw new Error(
      "A model running on the Docker host must use host.docker.internal instead of localhost",
    );
  }

  const config = await presetToProviderConfig(model);
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

export const getSwarmModels = async (req: Request, res: Response) => {
  try {
    const registry = readModelRegistry();
    return res.status(200).json({
      models: registry.models.map(modelForClient),
      assignments: registry.assignments,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get models" });
  }
};

export const updateSwarmModels = async (req: Request, res: Response) => {
  try {
    const { models, assignments } = req.body;

    if (!Array.isArray(models)) {
      return res.status(400).json({ message: "models must be an array" });
    }

    // Duplicate ids would make the sanitizer rename one of them, so the
    // masked-key restore and verification would then look up (and re-verify)
    // under the wrong saved preset. Reject the request instead.
    const requestedIds = new Set<string>();
    for (const model of models) {
      const id = typeof model?.id === "string" ? model.id.trim() : "";
      if (!id) {
        return res.status(400).json({ message: "Each model must have an id" });
      }
      if (requestedIds.has(id)) {
        return res.status(400).json({ message: `Duplicate model id "${id}"` });
      }
      requestedIds.add(id);
    }

    const normalized = normalizeModelRegistryInput(models, assignments || {});
    if (models.length > 0 && normalized.models.length !== models.length) {
      return res.status(400).json({
        message:
          "Each model must have id, label, valid provider, and model fields",
      });
    }

    const existing = readModelRegistry();
    const existingById = new Map(existing.models.map((model) => [model.id, model]));
    const modelsWithPreservedSecrets = models.map((model: any) => {
      const saved = existingById.get(model.id);
      if (typeof model.apiKey === "string" && model.apiKey.includes("•")) {
        return { ...model, apiKey: saved?.apiKey };
      }
      return model;
    });

    const normalizedWithSecrets = normalizeModelRegistryInput(
      modelsWithPreservedSecrets,
      assignments || {},
    );
    const assignedIds = new Set([
      normalizedWithSecrets.assignments.orchestratorModelId,
      normalizedWithSecrets.assignments.browserModelId,
    ].filter(Boolean));
    const verifiedModels = [];
    for (const model of normalizedWithSecrets.models) {
      const saved = existingById.get(model.id);
      const changed = !saved ||
        saved.provider !== model.provider ||
        saved.model !== model.model ||
        (saved.apiKey || "") !== (model.apiKey || "") ||
        (saved.baseURL || "") !== (model.baseURL || "");
      const mustVerify = changed || (assignedIds.has(model.id) && !saved?.verifiedAt);
      verifiedModels.push({
        ...model,
        verifiedAt: mustVerify ? await verifyModelPreset(model) : saved?.verifiedAt,
      });
    }

    const registry = writeModelRegistry(
      verifiedModels,
      assignments || {},
    );
    clearProviderCache();

    return res.status(200).json({
      message: "Models updated",
      models: registry.models.map(modelForClient),
      assignments: registry.assignments,
    });
  } catch (error: any) {
    console.log(error);
    return res.status(400).json({
      message: error?.message || "Failed to update models",
    });
  }
};

export const getSubscriptionProviders = async (
  _req: Request,
  res: Response,
) => {
  try {
    const providers = await getSubscriptionProviderStatuses();
    return res.status(200).json({ providers });
  } catch (error: any) {
    return res.status(500).json({
      message: error?.message || "Failed to inspect subscription providers",
    });
  }
};

export const connectSubscriptionProvider = async (
  req: Request,
  res: Response,
) => {
  try {
    const provider = String(req.body?.provider || "");
    if (!isSubscriptionProvider(provider)) {
      return res.status(400).json({ message: "Invalid subscription provider" });
    }

    const statuses = await getSubscriptionProviderStatuses();
    const status = statuses.find((entry) => entry.provider === provider)!;
    if (!status.installed || !status.authenticated) {
      return res.status(409).json({
        message: status.detail || `Run ${status.loginCommand} first`,
        status,
      });
    }

    const model = String(req.body?.model || status.defaultModel);
    if (!status.models.includes(model)) {
      return res.status(400).json({
        message: `Unsupported ${provider} model: ${model}`,
      });
    }

    const registry = readModelRegistry();
    const existing = registry.models.find(
      (entry) => entry.provider === provider && entry.model === model,
    );
    const id = existing?.id || `${provider}-${model}`;
    const label =
      String(req.body?.label || "") ||
      (provider === "codex-subscription"
        ? `Codex · ${model}`
        : `Claude Code · ${model}`);
    const preset = {
      id,
      label,
      provider,
      model,
      reasoningMode: req.body?.reasoningMode || "high",
    };
    const models = existing
      ? registry.models.map((entry) => (entry.id === id ? preset : entry))
      : [...registry.models, preset];
    const assignments = {
      ...registry.assignments,
      orchestratorModelId:
        req.body?.assignOrchestrator === true ||
        !registry.assignments.orchestratorModelId
          ? id
          : registry.assignments.orchestratorModelId,
    };
    const updated = writeModelRegistry(models, assignments);
    clearProviderCache();

    return res.status(200).json({
      message: `${provider === "codex-subscription" ? "Codex" : "Claude Code"} subscription connected`,
      model: updated.models.find((entry) => entry.id === id),
      assignments: updated.assignments,
      status,
    });
  } catch (error: any) {
    return res.status(500).json({
      message: error?.message || "Failed to connect subscription provider",
    });
  }
};

export const testSubscriptionProvider = async (
  req: Request,
  res: Response,
) => {
  try {
    const provider = String(req.body?.provider || "");
    if (!isSubscriptionProvider(provider)) {
      return res.status(400).json({ message: "Invalid subscription provider" });
    }
    const statuses = await getSubscriptionProviderStatuses();
    const status = statuses.find((entry) => entry.provider === provider)!;
    if (!status.authenticated) {
      return res.status(409).json({
        message: status.detail || `Run ${status.loginCommand} first`,
      });
    }
    const model = String(req.body?.model || status.defaultModel);
    const result = await invokeSubscriptionInference({
      provider,
      model,
      reasoningMode: "low",
      messages: [{ role: "user", content: "Reply with exactly: connected" }],
      format: "text",
    });
    const registry = readModelRegistry();
    const verifiedAt = new Date().toISOString();
    writeModelRegistry(
      registry.models.map((entry) =>
        entry.provider === provider && entry.model === model
          ? { ...entry, verifiedAt }
          : entry,
      ),
      registry.assignments,
    );
    clearProviderCache();
    return res.status(200).json({
      ok: result.content?.trim().toLowerCase().includes("connected") ?? false,
      model: result.model,
      content: result.content,
      usage: result.usage,
      verifiedAt,
    });
  } catch (error: any) {
    return res.status(502).json({
      message: error?.message || "Subscription inference test failed",
    });
  }
};

// ─── Capabilities ────────────────────────────────────────────────────

import {
  capabilityBuckets,
  allCapabilities,
  buildDetectionScript,
  parseDetectionOutput,
} from "../capabilities/registry";
import { execSSHCommand } from "../services/ssh.service";

export const getCapabilities = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    return res.status(200).json({
      buckets: capabilityBuckets,
      selectedCapabilities: user.configs.capabilities ?? [],
      installedCapabilities: user.configs.installedCapabilities ?? [],
      toolExecutionMode: resolveToolExecutionMode(user.configs),
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get capabilities" });
  }
};

export const updateCapabilities = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const { capabilities, toolExecutionMode } = req.body;

    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities)) {
        return res.status(400).json({ message: "Invalid capabilities data" });
      }
      user.configs.capabilities = capabilities;

      const toolNames = capabilities.filter((name: string) => {
        const cap = allCapabilities.find((c) => c.name === name);
        return cap && cap.type === "binary";
      });
      user.configs.tools = toolNames;
    }

    if (toolExecutionMode !== undefined) {
      if (!["auto", "auto_approve", "requires_consent"].includes(toolExecutionMode)) {
        return res.status(400).json({ message: "Invalid tool execution mode" });
      }
      user.configs.toolExecutionMode = toolExecutionMode;
      user.configs.requireConsentForAllTools = undefined;
    }

    await user.save();
    return res.status(200).json({ message: "Capabilities updated" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to update capabilities" });
  }
};

export const detectCapabilities = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const selected: string[] =
      user.configs.capabilities ?? allCapabilities.map((c) => c.name);

    const script = buildDetectionScript(selected);
    const output = await execSSHCommand(script);
    const results = parseDetectionOutput(output);

    const installed = Object.entries(results)
      .filter(([, isInstalled]) => isInstalled)
      .map(([name]) => name);

    user.configs.installedCapabilities = installed;
    await user.save();

    return res.status(200).json({
      installedCapabilities: installed,
      detectionResults: results,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({
      message:
        "Failed to detect capabilities. Ensure SSH/Exploit Box is connected.",
    });
  }
};

// ─── Server-level Model Configuration (reads/writes .env) ────────────

import { readEnvFile, updateEnvVars } from "../utils/envWriter";

export const getModelConfig = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();

    const mask = (key?: string) =>
      key
        ? `${key.slice(0, 4)}${"•".repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`
        : "";

    const oauthToken = env.ANTHROPIC_OAUTH_ACCESS_TOKEN || "";
    const oauthConnected = !!oauthToken;
    const registry = readModelRegistry();
    const orchestrator = registry.models.find(
      (model) => model.id === registry.assignments.orchestratorModelId,
    );

    const provider = orchestrator?.provider || "openai";
    const model = orchestrator?.model || "";
    const apiKey = orchestrator?.apiKey || "";
    const baseURL = orchestrator?.baseURL || "";
    const isOAuth = provider === "anthropic" && oauthConnected;
    const configured = !!(model && (apiKey || isOAuth));

    const reasoningMode = orchestrator?.reasoningMode || "off";

    return res.status(200).json({
      id: orchestrator?.id || "",
      provider,
      model,
      apiKey: mask(apiKey),
      baseURL,
      configured,
      authMethod: isOAuth ? "oauth" : "api_key",
      oauthConnected: isOAuth,
      reasoningMode,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get model config" });
  }
};

export const updateModelConfig = async (req: Request, res: Response) => {
  try {
    const { label, provider, model, apiKey, baseURL, reasoningMode } = req.body;

    if (!provider || !model) {
      return res
        .status(400)
        .json({ message: "Provider and model are required" });
    }

    const env = readEnvFile();
    const hasOAuth = !!env.ANTHROPIC_OAUTH_ACCESS_TOKEN;
    if (
      !apiKey &&
      !(provider === "anthropic" && hasOAuth) &&
      provider !== "ollama" &&
      !isSubscriptionProvider(provider)
    ) {
      return res.status(400).json({ message: "API key is required" });
    }

    const validProviders = [
      "openai",
      "anthropic",
      "anthropic-compatible",
      "openrouter",
      "google",
      "mistralai",
      "ollama",
      "openai-compatible",
      "kimi",
      "bedrock",
      "codex-subscription",
      "claude-subscription",
    ];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        message: `Invalid provider. Must be one of: ${validProviders.join(", ")}`,
      });
    }

    if (
      reasoningMode &&
      !["off", "low", "medium", "high", "xhigh", "max"].includes(reasoningMode)
    ) {
      return res.status(400).json({
        message:
          "Invalid reasoning mode. Must be one of: off, low, medium, high, xhigh, max",
      });
    }

    const registry = readModelRegistry();
    const existingId =
      registry.assignments.orchestratorModelId ||
      `${provider}-${model}`.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
    const existing = registry.models.find((entry) => entry.id === existingId);
    const isApiKeyMasked = apiKey?.includes("•");
    const entry = {
      id: existingId,
      label: label || existing?.label || "Orchestrator",
      provider,
      model,
      apiKey: isApiKeyMasked ? existing?.apiKey : apiKey || "",
      baseURL: baseURL || "",
      reasoningMode: reasoningMode || "off",
    };
    const models = existing
      ? registry.models.map((item) => (item.id === existingId ? entry : item))
      : [...registry.models, entry];

    writeModelRegistry(models, {
      ...registry.assignments,
      orchestratorModelId: existingId,
    });
    clearProviderCache();

    return res.status(200).json({ message: "Model config updated" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to update model config" });
  }
};

export const deleteModelConfig = async (req: Request, res: Response) => {
  try {
    const registry = readModelRegistry();
    writeModelRegistry(registry.models, {
      ...registry.assignments,
      orchestratorModelId: undefined,
    });
    clearProviderCache();

    return res.status(200).json({ message: "Model config reset to defaults" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to delete model config" });
  }
};

// ─── Anthropic OAuth (writes tokens to .env) ─────────────────────────

const ANTHROPIC_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authURL: "https://claude.ai/oauth/authorize",
  tokenURL: "https://console.anthropic.com/v1/oauth/token",
  redirectURI: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
};

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

const oauthStateStore = new Map<
  string,
  { verifier: string; userId: string; expiresAt: number }
>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStateStore) {
    if (val.expiresAt < now) oauthStateStore.delete(key);
  }
}, 60_000);

export const initiateAnthropicOAuth = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;

    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");

    oauthStateStore.set(state, {
      verifier,
      userId: userId.toString(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_OAUTH.clientId,
      response_type: "code",
      redirect_uri: ANTHROPIC_OAUTH.redirectURI,
      scope: ANTHROPIC_OAUTH.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });

    return res.status(200).json({
      authorizationURL: `${ANTHROPIC_OAUTH.authURL}?${params.toString()}`,
      state,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to initiate OAuth" });
  }
};

export const exchangeAnthropicOAuth = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { code, state } = req.body;

    if (!code || !state) {
      return res.status(400).json({ message: "Code and state are required" });
    }

    const stored = oauthStateStore.get(state);
    if (!stored || stored.userId !== userId.toString()) {
      return res
        .status(400)
        .json({ message: "Invalid or expired OAuth state" });
    }

    oauthStateStore.delete(state);

    const codeParts = code.split("#");
    const authCode = codeParts[0];

    const tokenResponse = await axios.post(
      ANTHROPIC_OAUTH.tokenURL,
      new URLSearchParams({
        code: authCode,
        state,
        grant_type: "authorization_code",
        client_id: ANTHROPIC_OAUTH.clientId,
        redirect_uri: ANTHROPIC_OAUTH.redirectURI,
        code_verifier: stored.verifier,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    updateEnvVars({
      ANTHROPIC_OAUTH_ACCESS_TOKEN: access_token,
      ANTHROPIC_OAUTH_REFRESH_TOKEN: refresh_token,
      ANTHROPIC_OAUTH_EXPIRES_AT: String(
        Math.floor(Date.now() / 1000) + (expires_in || 3600),
      ),
    });

    const { clearProviderCache } = await import("../utils/llm/providers");
    clearProviderCache();

    return res
      .status(200)
      .json({ message: "Claude account connected via OAuth" });
  } catch (error: any) {
    console.log("OAuth exchange error:", error?.response?.data || error);
    const msg =
      error?.response?.data?.error_description || "OAuth token exchange failed";
    return res.status(400).json({ message: msg });
  }
};

export const disconnectAnthropicOAuth = async (
  _req: Request,
  res: Response,
) => {
  try {
    updateEnvVars({
      ANTHROPIC_OAUTH_ACCESS_TOKEN: "",
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "",
      ANTHROPIC_OAUTH_EXPIRES_AT: "",
    });

    const { clearProviderCache } = await import("../utils/llm/providers");
    clearProviderCache();

    return res.status(200).json({ message: "Claude OAuth disconnected" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to disconnect OAuth" });
  }
};

// ─── VNC / GUI Configuration (delegates to vnc-provisioning.service) ─

export const getVNCConfig = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(getVncConfig());
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get VNC config" });
  }
};

export const updateVNCConfig = async (req: Request, res: Response) => {
  try {
    updateVncConfig(req.body || {});
    return res.status(200).json({ message: "VNC configuration saved" });
  } catch (error: any) {
    console.log(error);
    return res.status(400).json({
      message: error?.message || "Failed to update VNC config",
    });
  }
};

export const resetVNCConfig = async (_req: Request, res: Response) => {
  try {
    resetVncConfig();
    return res.status(200).json({ message: "VNC configuration reset" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to reset VNC config" });
  }
};

export const autoSetupVNC = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    const session = await requireActiveSession(res.locals.userId, sessionId, res);
    if (!session) return;
    const result = await provisionVnc(sessionId);
    return res.status(200).json(result);
  } catch (error: any) {
    console.log(error);
    return res.status(400).json({
      message:
        error?.message ||
        "VNC auto-setup failed. Ensure SSH/Exploit Box is configured.",
    });
  }
};

export const diagnoseVNC = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    const session = await requireActiveSession(res.locals.userId, sessionId, res);
    if (!session) return;
    console.log("[VNC Diagnose] Diagnose endpoint called");
    const checks = await runDiagnostics(sessionId);
    const allPassed = checks.every((c) => c.status === "pass");
    console.log(`[VNC Diagnose] All passed: ${allPassed}`);
    return res.status(200).json({ checks, allPassed });
  } catch (error: any) {
    console.error("[VNC Diagnose] Top-level error:", error);
    return res.status(400).json({
      message:
        error?.message || "Diagnostics failed. Ensure SSH is configured.",
    });
  }
};

export const repairVNC = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    const session = await requireActiveSession(res.locals.userId, sessionId, res);
    if (!session) return;
    const result = await repairVncSession(sessionId, req.body?.fix || "all");
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[VNC Repair] Top-level error:", error);
    return res.status(400).json({
      message: error?.message || "Repair failed. Ensure SSH is configured.",
    });
  }
};


// ─── SSH Configuration (reads/writes .env) ───────────────────────────

export const getSSHConfig = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    const user = res.locals.user;

    return res.status(200).json({
      host: env.SSH_HOST || "",
      port: env.SSH_PORT || "22",
      username: env.SSH_USERNAME || "",
      authMethod: env.SSH_PRIVATE_KEY ? "key" : "password",
      // Never send the credential itself back to the client.
      hasPassword: !!env.SSH_PASSWORD,
      hasPrivateKey: !!env.SSH_PRIVATE_KEY,
      configured: !!(env.SSH_HOST && env.SSH_USERNAME),
      disableSafetyProtections:
        user?.configs?.disableSafetyProtections ?? false,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get SSH config" });
  }
};

export const updateSSHConfig = async (req: Request, res: Response) => {
  try {
    const {
      host,
      port,
      username,
      authMethod,
      password,
      privateKeyPath,
      passphrase,
      disableSafetyProtections,
    } = req.body;

    if (!host || !username) {
      return res
        .status(400)
        .json({ message: "Host and username are required" });
    }

    const env = readEnvFile();
    const updates: Record<string, string> = {
      SSH_HOST: host,
      SSH_PORT: String(port || 22),
      SSH_USERNAME: username,
    };

    if (authMethod === "key") {
      updates.SSH_PRIVATE_KEY = privateKeyPath || env.SSH_PRIVATE_KEY || "";
      updates.SSH_PRIVATE_KEY_PASSPHRASE =
        passphrase || env.SSH_PRIVATE_KEY_PASSPHRASE || "";
      updates.SSH_PASSWORD = "";
    } else {
      updates.SSH_PASSWORD = password || env.SSH_PASSWORD || "";
      updates.SSH_PRIVATE_KEY = "";
      updates.SSH_PRIVATE_KEY_PASSPHRASE = "";
    }

    updateEnvVars(updates);

    if (typeof disableSafetyProtections === "boolean") {
      const user = res.locals.user;
      user.configs.disableSafetyProtections = disableSafetyProtections;
      await user.save();
    }

    return res.status(200).json({ message: "SSH configuration updated" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to update SSH config" });
  }
};

export const updateSafetyProtections = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const { disableSafetyProtections } = req.body;

    if (typeof disableSafetyProtections !== "boolean") {
      return res
        .status(400)
        .json({ message: "disableSafetyProtections must be a boolean" });
    }

    user.configs.disableSafetyProtections = disableSafetyProtections;
    await user.save();

    return res.status(200).json({
      message: "Safety protections updated",
      disableSafetyProtections,
    });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to update safety protections" });
  }
};

export const saveUserInformation = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;
    const { industry, experience, discoveryMethod } = req.body;

    if (!industry || !experience || !discoveryMethod) {
      return res.status(400).json({ message: "Missing user information!" });
    }

    if (user.firstLogin === false) {
      return res
        .status(400)
        .json({ message: "User information already saved!" });
    }

    user.workingIndustry = industry;
    user.workingExperience = experience;
    user.referralSource = discoveryMethod;

    user.firstLogin = false;

    user.configs.tools = [
      "nmap",
      "feroxbuster",
      "subfinder",
      "hydra",
      "sqlmap",
    ];

    await user.save();

    return res.status(200).json({ message: "User information saved!" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Error! failed to save details" });
  }
};

export const getAvailableModels = async (_req: Request, res: Response) => {
  try {
    const providers = await fetchModelsCatalog();
    return res.status(200).json({ providers });
  } catch (error: any) {
    console.error("[user] Failed to fetch available models:", error.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch available models" });
  }
};

export const getBurpConfig = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    return res.status(200).json({
      host: env.BURP_RPC_HOST || "",
      port: env.BURP_RPC_PORT || "50051",
      configured: !!env.BURP_RPC_HOST,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get Burp config" });
  }
};

export const updateBurpConfig = async (req: Request, res: Response) => {
  try {
    const { host, port } = req.body;

    if (!host) {
      return res.status(400).json({ message: "Host is required" });
    }

    updateEnvVars({
      BURP_RPC_HOST: host,
      BURP_RPC_PORT: String(port || 50051),
    });

    return res.status(200).json({ message: "Burp configuration updated" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to update Burp config" });
  }
};

// ─── Magnitude Browser Agent Configuration ───────────────────────────

export const getMagnitudeConfig = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    const modelRegistry = readModelRegistry();
    const owner = await isHostOwner(res.locals.userId);
    const browserModel = modelRegistry.models.find(
      (model) => model.id === modelRegistry.assignments.browserModelId,
    );
    const visibleModels = owner
      ? modelRegistry.models
      : modelRegistry.models.filter(
          (model) => !isSubscriptionProvider(model.provider),
        );
    const visibleBrowserModel =
      browserModel &&
      (owner || !isSubscriptionProvider(browserModel.provider))
        ? browserModel
        : null;

    return res.status(200).json({
      enabled: env.MAGNITUDE_ENABLED === "true",
      proxyUrl: env.MAGNITUDE_PROXY_URL || "",
      headless: env.MAGNITUDE_HEADLESS !== "false",
      displayPort: env.MAGNITUDE_DISPLAY || "",
      configured: env.MAGNITUDE_ENABLED === "true",
      browserModelId: visibleBrowserModel?.id || "",
      browserModel: visibleBrowserModel,
      models: visibleModels,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get Magnitude config" });
  }
};

export const updateMagnitudeConfig = async (req: Request, res: Response) => {
  try {
    const { enabled, proxyUrl, headless, displayPort, browserModelId } =
      req.body;

    if (
      browserModelId !== undefined &&
      !(await isHostOwner(res.locals.userId))
    ) {
      return res.status(403).json({
        message:
          "Only the installation owner can change the host Browser Agent model assignment",
      });
    }

    const updates: Record<string, string> = {
      MAGNITUDE_ENABLED: String(!!enabled),
      MAGNITUDE_HEADLESS: String(headless !== false),
    };

    if (proxyUrl !== undefined) {
      updates.MAGNITUDE_PROXY_URL = proxyUrl || "";
    }

    if (displayPort !== undefined) {
      updates.MAGNITUDE_DISPLAY = displayPort || "";
    }

    updateEnvVars(updates);
    // Rebuilding the shared browser is lazy, but release a live one when the
    // agent is switched off so it is not left running in the background.
    if (!enabled) {
      void runBrowserAgentExclusive(stopBrowserAgent);
    }

    if (browserModelId !== undefined) {
      const registry = readModelRegistry();
      writeModelRegistry(registry.models, {
        ...registry.assignments,
        browserModelId: browserModelId || undefined,
      });
      clearProviderCache();
    }

    return res.status(200).json({ message: "Magnitude configuration updated" });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to update Magnitude config" });
  }
};

// The browser agent is shared with the orchestrator browser_action tool, so a
// run started here and one started from chat reuse the same warm Chromium
// instead of each cold-starting their own (see browser-agent.service.ts).
export const startMagnitudeAgent = async (req: Request, res: Response) => {
  try {
    const { goal, targetUrl } = req.body;

    if (!goal) {
      return res
        .status(400)
        .json({ message: "A goal is required to start the browser agent" });
    }

    if (!targetUrl) {
      return res.status(400).json({ message: "A target URL is required" });
    }

    const env = readEnvFile();

    if (env.MAGNITUDE_ENABLED !== "true") {
      return res.status(400).json({
        message:
          "Magnitude browser agent is not enabled. Enable it in Settings -> Browser Agent.",
      });
    }

    const browserModel = getAssignedModels().browser;
    if (!browserModel) {
      return res.status(400).json({
        message:
          "No Browser Agent model selected. Assign one in Settings -> Models.",
      });
    }
    if (!browserModel.verifiedAt) {
      return res.status(400).json({
        message:
          "The Browser Agent model is unverified. Test and save it in Settings -> Models.",
      });
    }

    if (
      isSubscriptionProvider(browserModel.provider) &&
      !(await isHostOwner(res.locals.userId))
    ) {
      return res.status(403).json({
        message:
          "The selected Browser Agent model uses a host CLI subscription reserved for the installation owner",
      });
    }

    const providerConfig = await presetToProviderConfig(browserModel);
    const { apiKey } = providerConfig;
    const proxyUrl = env.MAGNITUDE_PROXY_URL || "";
    const headless = env.MAGNITUDE_HEADLESS !== "false";
    const display = env.MAGNITUDE_DISPLAY || getBrowserAgentDisplay();
    const normalizedDisplay = display.startsWith(":") ? display : `:${display}`;

    if (!apiKey) {
      return res.status(400).json({
        message:
          "The selected Browser Agent model has no API key. Configure it in Settings -> Models.",
      });
    }

    // Always ensure DISPLAY is set for the process
    process.env.DISPLAY = normalizedDisplay;

    const llm = await resolveMagnitudeLlmConfig(
      providerConfig,
      browserModel.reasoningMode,
    );
    const { fingerprint, agentConfig } = buildBrowserAgentConfig({
      llm,
      headless,
      proxyUrl,
      display: normalizedDisplay,
      screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
    });

    try {
      await runBrowserAgentExclusive(async () => {
        const agent = await ensureBrowserAgent(fingerprint, agentConfig);
        await agent.nav(targetUrl);
        await agent.act(goal);
      });
    } catch (agentError: any) {
      // A failed run can leave the browser in a bad state; drop it so the next
      // run starts from a clean context instead of inheriting the wreckage.
      await runBrowserAgentExclusive(stopBrowserAgent);
      return res.status(500).json({
        message: `Browser agent failed: ${formatMagnitudeError(agentError)}`,
        goal,
        targetUrl,
      });
    }

    // Kept open on purpose - the live view shows the final browser state until
    // the next run reuses it (or the idle timeout releases it).
    scheduleBrowserAgentIdleStop();
    return res.status(200).json({
      message: "Browser agent completed the goal successfully",
      goal,
      targetUrl,
    });
  } catch (error: any) {
    console.log(error);
    return res.status(500).json({
      message: `Failed to start Magnitude agent: ${formatMagnitudeError(error)}`,
    });
  }
};

export const getBrowserAgentVNC = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    const magnitudeEnabled = env.MAGNITUDE_ENABLED === "true";
    const headless = env.MAGNITUDE_HEADLESS !== "false";
    const display = env.MAGNITUDE_DISPLAY || getBrowserAgentDisplay();
    const novncPort = String(getBrowserAgentNovncPort());

    const fs = await import("fs");
    const inDocker = fs.existsSync("/.dockerenv");

    // Probe the stack instead of assuming it is up because we are in Docker.
    // x11vnc dies whenever Xvfb fails, which leaves websockify happily serving
    // the noVNC page with nothing behind it — the client then renders a bare
    // "Failed to connect to server" with no explanation.
    const [rfbUp, novncUp] = inDocker
      ? await Promise.all([
          isPortListening(getBrowserAgentRfbPort()),
          isPortListening(getBrowserAgentNovncPort()),
        ])
      : [false, false];

    const vncRunning = inDocker && rfbUp && novncUp;

    return res.status(200).json({
      // `available` stays config-intent (headed mode requested); `vncRunning`
      // reports whether the stream is actually serviceable right now.
      available: magnitudeEnabled && !headless,
      enabled: magnitudeEnabled,
      headless,
      display,
      novncPort,
      vncRunning,
      rfbUp,
      novncUp,
      mode: inDocker ? "docker" : "dev",
    });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to get Browser Agent VNC config" });
  }
};
