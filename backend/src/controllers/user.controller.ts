import { Response, Request } from "express";
import crypto from "crypto";
import axios from "axios";
import { getAvailableModels as fetchModelsCatalog } from "../services/models-catalog.service";
import { applyEnvUpdates } from "../utils/llm/orchestrator";
import {
  getSubscriptionProviderStatuses,
  invokeSubscriptionInference,
  isSubscriptionProvider,
} from "../services/subscription-inference.service";
import {
  assignOrchestratorPreset,
  clearOrchestratorAssignment,
  connectSubscriptionPreset,
  markPresetVerified,
  saveModels,
} from "../services/model-settings.service";
import { readModelRegistry } from "../utils/modelRegistryStore";
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

    const registry = await saveModels(models, assignments || {});

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

    const { registry, presetId } = connectSubscriptionPreset({
      provider,
      model,
      label: req.body?.label,
      reasoningMode: req.body?.reasoningMode,
      assignOrchestrator: req.body?.assignOrchestrator === true,
    });

    return res.status(200).json({
      message: `${provider === "codex-subscription" ? "Codex" : "Claude Code"} subscription connected`,
      model: registry.models.find((entry) => entry.id === presetId),
      assignments: registry.assignments,
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
    const registry = markPresetVerified(provider, model);
    const verifiedAt = registry.models.find(
      (entry) => entry.provider === provider && entry.model === model,
    )?.verifiedAt;
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

import { readEnvFile } from "../utils/envWriter";

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
    await assignOrchestratorPreset(req.body);

    return res.status(200).json({ message: "Model config updated" });
  } catch (error: any) {
    console.log(error);
    return res.status(400).json({
      message: error?.message || "Failed to update model config",
    });
  }
};

export const deleteModelConfig = async (_req: Request, res: Response) => {
  try {
    clearOrchestratorAssignment();

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

    applyEnvUpdates({
      ANTHROPIC_OAUTH_ACCESS_TOKEN: access_token,
      ANTHROPIC_OAUTH_REFRESH_TOKEN: refresh_token,
      ANTHROPIC_OAUTH_EXPIRES_AT: String(
        Math.floor(Date.now() / 1000) + (expires_in || 3600),
      ),
    });

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
    applyEnvUpdates({
      ANTHROPIC_OAUTH_ACCESS_TOKEN: "",
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "",
      ANTHROPIC_OAUTH_EXPIRES_AT: "",
    });

    return res.status(200).json({ message: "Claude OAuth disconnected" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to disconnect OAuth" });
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
