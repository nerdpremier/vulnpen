import { Request, Response } from "express";
import { readEnvFile, updateEnvVars } from "../utils/envWriter";
import {
  buildMcpConfigTemplate,
  buildMcpEndpoint,
  buildMcpEnvTemplate,
  createMcpToken,
  ensureDefaultMcpToken,
  listActiveMcpTokens,
  revokeMcpToken,
} from "../services/mcp-auth.service";

function resolveBackendBaseUrl(req: Request): string {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : typeof forwardedProto === "string"
      ? forwardedProto.split(",")[0]
      : req.protocol;
  return `${protocol}://${req.get("host")}`;
}

function serializeToken(token: {
  tokenId: string;
  label: string;
  token?: string;
  createdAt: Date;
  lastUsedAt?: Date;
}) {
  return {
    tokenId: token.tokenId,
    label: token.label,
    // Plaintext only exists on legacy docs not yet upgraded; new tokens are
    // stored hashed and were shown once at creation time.
    token: token.token || null,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt || null,
  };
}

const MCP_TOKEN_PLACEHOLDER = "<your-mcp-token>";

export async function getMcpConfig(req: Request, res: Response) {
  try {
    const user = res.locals.user;
    const env = readEnvFile();
    const baseUrl = resolveBackendBaseUrl(req);
    const { doc: token, plaintextToken } = await ensureDefaultMcpToken(user);
    const activeTokens = listActiveMcpTokens(user);

    const displayToken = plaintextToken ?? token.token ?? null;

    return res.status(200).json({
      endpoint: buildMcpEndpoint(baseUrl),
      token: displayToken,
      configTemplate: buildMcpConfigTemplate(baseUrl, displayToken ?? MCP_TOKEN_PLACEHOLDER),
      envTemplate: buildMcpEnvTemplate(baseUrl, displayToken ?? MCP_TOKEN_PLACEHOLDER),
      safety: {
        allowDangerousMcp: env.PENTEST_MCP_ALLOW_DANGEROUS === "1",
        maxOutputChars: Number(env.PENTEST_MCP_MAX_OUTPUT_CHARS || 60000),
      },
      tokens: activeTokens.map(serializeToken),
    });
  } catch (error) {
    console.error("[mcp] getMcpConfig error:", error);
    return res.status(400).json({ message: "Failed to load MCP config" });
  }
}

export async function updateMcpSafety(req: Request, res: Response) {
  try {
    const { allowDangerousMcp } = req.body || {};
    if (typeof allowDangerousMcp !== "boolean") {
      return res
        .status(400)
        .json({ message: "allowDangerousMcp must be a boolean" });
    }

    updateEnvVars({
      PENTEST_MCP_ALLOW_DANGEROUS: allowDangerousMcp ? "1" : "0",
    });

    return res.status(200).json({
      message: allowDangerousMcp
        ? "MCP dangerous tools enabled"
        : "MCP dangerous tools disabled",
      safety: { allowDangerousMcp },
    });
  } catch (error) {
    console.error("[mcp] updateMcpSafety error:", error);
    return res.status(400).json({ message: "Failed to update MCP safety" });
  }
}

export async function createMcpAccessToken(req: Request, res: Response) {
  try {
    const user = res.locals.user;
    const { label } = req.body || {};
    const { doc, plaintextToken } = await createMcpToken(user, label);
    return res.status(200).json({
      // The only response that carries this token's plaintext.
      token: { ...serializeToken(doc), token: plaintextToken },
      message: "MCP token created",
    });
  } catch (error) {
    console.error("[mcp] createMcpAccessToken error:", error);
    return res.status(400).json({ message: "Failed to create MCP token" });
  }
}

export async function revokeMcpAccessToken(req: Request, res: Response) {
  try {
    const user = res.locals.user;
    const { tokenId } = req.params;
    if (!tokenId) {
      return res.status(400).json({ message: "tokenId is required" });
    }

    const revoked = await revokeMcpToken(user, tokenId);
    if (!revoked) {
      return res.status(404).json({ message: "Token not found" });
    }

    return res.status(200).json({ message: "MCP token revoked" });
  } catch (error) {
    console.error("[mcp] revokeMcpAccessToken error:", error);
    return res.status(400).json({ message: "Failed to revoke MCP token" });
  }
}
