import crypto from "crypto";
import axios from "axios";
import { applyEnvUpdates } from "../utils/llm/orchestrator";

const ANTHROPIC_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authURL: "https://claude.ai/oauth/authorize",
  tokenURL: "https://console.anthropic.com/v1/oauth/token",
  redirectURI: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
};

const STATE_TTL_MS = 10 * 60 * 1000;

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

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/** Start the PKCE flow: mint a state, remember the verifier, return the consent URL. */
export function beginAnthropicOAuth(userId: string | number): {
  authorizationURL: string;
  state: string;
} {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  oauthStateStore.set(state, {
    verifier,
    userId: userId.toString(),
    expiresAt: Date.now() + STATE_TTL_MS,
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

  return { authorizationURL: `${ANTHROPIC_OAUTH.authURL}?${params.toString()}`, state };
}

/** Exchange an authorization code for tokens and persist them. Throws on bad state or token failure. */
export async function completeAnthropicOAuth(input: {
  code: string;
  state: string;
  userId: string | number;
}): Promise<void> {
  const stored = oauthStateStore.get(input.state);
  if (!stored || stored.userId !== input.userId.toString()) {
    throw new Error("Invalid or expired OAuth state");
  }
  oauthStateStore.delete(input.state);

  const authCode = input.code.split("#")[0];
  const tokenResponse = await axios.post(
    ANTHROPIC_OAUTH.tokenURL,
    new URLSearchParams({
      code: authCode,
      state: input.state,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH.clientId,
      redirect_uri: ANTHROPIC_OAUTH.redirectURI,
      code_verifier: stored.verifier,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  const { access_token, refresh_token, expires_in } = tokenResponse.data;
  applyEnvUpdates({
    ANTHROPIC_OAUTH_ACCESS_TOKEN: access_token,
    ANTHROPIC_OAUTH_REFRESH_TOKEN: refresh_token,
    ANTHROPIC_OAUTH_EXPIRES_AT: String(
      Math.floor(Date.now() / 1000) + (expires_in || 3600),
    ),
  });
}

export function disconnectAnthropicOAuth(): void {
  applyEnvUpdates({
    ANTHROPIC_OAUTH_ACCESS_TOKEN: "",
    ANTHROPIC_OAUTH_REFRESH_TOKEN: "",
    ANTHROPIC_OAUTH_EXPIRES_AT: "",
  });
}
