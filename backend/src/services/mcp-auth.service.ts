import crypto from "crypto";
import UserModel, { McpTokenDoc, UserDoc } from "../models/User/User.model";

const MCP_TOKEN_PREFIX = "vp_mcp_";
const DEFAULT_TOKEN_LABEL = "Universal MCP Token";

function stableStringCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function generateMcpTokenValue(): string {
  return `${MCP_TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
}

// Tokens are stored hashed (SHA-256); the plaintext is returned exactly once,
// at creation time. Legacy plaintext tokens are upgraded lazily on first use.
function hashMcpToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function buildMcpEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

export function buildMcpConfigTemplate(baseUrl: string, token: string): string {
  return [
    "name: vulnpen",
    "transport:",
    "  type: http",
    `  url: ${buildMcpEndpoint(baseUrl)}`,
    "auth:",
    "  type: bearer",
    `  token: ${token}`,
  ].join("\n");
}

export function buildMcpEnvTemplate(baseUrl: string, token: string): string {
  return [
    `VULNPEN_MCP_URL=${buildMcpEndpoint(baseUrl)}`,
    `VULNPEN_MCP_TOKEN=${token}`,
  ].join("\n");
}

export function createMcpTokenDoc(label?: string): {
  doc: McpTokenDoc;
  plaintextToken: string;
} {
  const token = generateMcpTokenValue();
  return {
    // `token` (plaintext) is deliberately left unset on the persisted doc; it
    // exists only on the returned object so the client can copy it once.
    doc: {
      tokenId: crypto.randomUUID(),
      label: (label || DEFAULT_TOKEN_LABEL).trim() || DEFAULT_TOKEN_LABEL,
      tokenHash: hashMcpToken(token),
      createdAt: new Date(),
      lastUsedAt: undefined,
      revokedAt: null,
    },
    plaintextToken: token,
  };
}

export async function ensureDefaultMcpToken(
  user: UserDoc,
): Promise<{ doc: McpTokenDoc; plaintextToken?: string }> {
  const existing = (user.configs.mcpTokens || []).find(
    (token) => !token.revokedAt,
  );
  if (existing) return { doc: existing };

  const { doc, plaintextToken } = createMcpTokenDoc(DEFAULT_TOKEN_LABEL);
  user.configs.mcpTokens = [...(user.configs.mcpTokens || []), doc];
  await user.save();
  return { doc, plaintextToken };
}

export async function createMcpToken(
  user: UserDoc,
  label?: string,
): Promise<{ doc: McpTokenDoc; plaintextToken: string }> {
  const { doc, plaintextToken } = createMcpTokenDoc(label);
  user.configs.mcpTokens = [...(user.configs.mcpTokens || []), doc];
  await user.save();
  return { doc, plaintextToken };
}

export async function revokeMcpToken(
  user: UserDoc,
  tokenId: string,
): Promise<boolean> {
  const tokens = user.configs.mcpTokens || [];
  const token = tokens.find(
    (candidate) => candidate.tokenId === tokenId && !candidate.revokedAt,
  );
  if (!token) return false;
  token.revokedAt = new Date();
  await user.save();
  return true;
}

export function listActiveMcpTokens(user: UserDoc): McpTokenDoc[] {
  return (user.configs.mcpTokens || []).filter((token) => !token.revokedAt);
}

export async function findUserByMcpToken(
  token: string,
): Promise<{ user: UserDoc; token: McpTokenDoc } | null> {
  if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const tokenHash = hashMcpToken(token);

  let user = await UserModel.findOne({
    "configs.mcpTokens": {
      $elemMatch: {
        tokenHash,
        revokedAt: null,
      },
    },
  });

  if (!user) {
    // Legacy tokens were stored in plaintext; match and upgrade to hashed.
    user = await UserModel.findOne({
      "configs.mcpTokens": {
        $elemMatch: {
          token,
          revokedAt: null,
        },
      },
    });
    if (user) {
      const legacy = (user.configs.mcpTokens || []).find(
        (candidate) =>
          !candidate.revokedAt && stableStringCompare(candidate.token!, token),
      );
      if (legacy) {
        legacy.tokenHash = tokenHash;
        legacy.token = undefined;
        await user.save();
      }
    }
  }

  if (!user) return null;

  const matched = (user.configs.mcpTokens || []).find(
    (candidate) => !candidate.revokedAt && stableStringCompare(candidate.tokenHash!, tokenHash),
  );

  if (!matched) return null;
  return { user, token: matched };
}

export async function touchMcpTokenUsage(
  user: UserDoc,
  tokenId: string,
): Promise<void> {
  await UserModel.updateOne(
    { _id: user._id, "configs.mcpTokens.tokenId": tokenId },
    { $set: { "configs.mcpTokens.$.lastUsedAt": new Date() } },
  );
}
