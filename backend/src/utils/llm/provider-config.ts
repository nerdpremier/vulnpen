import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { readEnvFile, updateEnvVars } from "../envWriter";
import type { ProviderConfig, ProviderType } from "./types";

// ─── Provider clients ────────────────────────────────────────────────
// How one ProviderConfig becomes a working SDK client: the per-provider
// base URLs and their defaults, the Bedrock region endpoint, the Anthropic
// header shapes, and the OAuth token refresh. The orchestrator module
// builds configs; this module turns a config into a client.

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

export function isAnthropicApiProvider(provider: ProviderType): boolean {
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

export function buildClient(config: ProviderConfig): OpenAI {
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

export function buildAnthropicClient(config: ProviderConfig): Anthropic {
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

export async function maybeRefreshOAuthToken(): Promise<string | null> {
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
