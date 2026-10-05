import { Request, Response } from "express";
import {
  BURP_DISCONNECTED_MSG,
  BURP_PING_TIMEOUT_MS,
  BurpCallFailure,
  decodeBurpBody,
  decodeBurpReply,
  encodeBurpBody,
  isBurpUnreachable,
  normalizeHttpRequest,
  sendRawHttpRequest,
  withBurpClient,
} from "../services/burp-client.service";
import { configureBurpCaTrust, getBurpCaStatus } from "../services/burp-ca.service";
import { readEnvFile, updateEnvVars } from "../utils/envWriter";

/**
 * Maps a withBurpClient failure to the HTTP response shape shared by every
 * endpoint: not-configured → 400, unreachable → 502, anything else → 500.
 */
function respondBurpFailure(
  res: Response,
  failure: BurpCallFailure,
  logLabel: string,
  errorMessage: string,
  extra: Record<string, unknown> = {}
) {
  if (failure.reason === "not-configured") {
    return res.status(400).json({ message: failure.message, ...extra });
  }
  if (failure.reason === "unreachable") {
    return res.status(502).json({ message: failure.message });
  }
  console.error(logLabel, (failure.error as any)?.message || failure.error);
  return res.status(500).json({ message: errorMessage });
}

/**
 * Lightweight health check for Burp connectivity.
 * Uses the dedicated Ping RPC to verify the gRPC channel is alive.
 */
async function burpConnectionStatus(_req: Request, res: Response) {
  const result = await withBurpClient((burp) => burp.ping(BURP_PING_TIMEOUT_MS));

  if (!result.ok) {
    return res.status(200).json({
      configured: result.reason !== "not-configured",
      connected: false,
      message: result.reason === "error" ? BURP_DISCONNECTED_MSG : result.message,
    });
  }

  const ping = result.value;
  return res.status(200).json({
    configured: true,
    connected: true,
    burpVersion: ping.burpVersion,
    extensionVersion: ping.extensionVersion,
  });
}

export const getBurpHealth = burpConnectionStatus;

export const getBurpCertificateStatus = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(await getBurpCaStatus());
  } catch (error: any) {
    console.error("[burp] CA status error:", error?.message || error);
    return res.status(500).json({ message: "Failed to inspect Burp CA trust." });
  }
};

export const configureBurpCertificate = async (_req: Request, res: Response) => {
  try {
    const ping = await withBurpClient((burp) => burp.ping(BURP_PING_TIMEOUT_MS));
    if (!ping.ok) {
      if (ping.reason === "not-configured") {
        return res.status(400).json({ message: "Connect Burp RPC before configuring HTTPS interception." });
      }
      if (ping.reason === "unreachable") {
        return res.status(502).json({ message: ping.message });
      }
      console.error("[burp] CA configuration error:", (ping.error as any)?.message || ping.error);
      return res.status(400).json({ message: ping.message });
    }

    return res.status(200).json(await configureBurpCaTrust());
  } catch (error: any) {
    console.error("[burp] CA configuration error:", error?.message || error);
    if (isBurpUnreachable(error)) {
      return res.status(502).json({ message: BURP_DISCONNECTED_MSG });
    }
    return res.status(400).json({ message: error?.message || "Failed to trust the Burp CA." });
  }
};

export const getBurpProxyHistory = async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string, 10) || 20));

  const filter: any = {};
  if (req.query.search) filter.search = req.query.search as string;
  if (req.query.method) filter.methods = (req.query.method as string).split(",").filter(Boolean);
  if (req.query.statusMin) filter.statusMin = parseInt(req.query.statusMin as string, 10) || 0;
  if (req.query.statusMax) filter.statusMax = parseInt(req.query.statusMax as string, 10) || 0;
  if (req.query.hideAssets === "true") filter.hideAssets = true;

  const result = await withBurpClient(async (burp) => {
    const allEntries = await burp.proxy.getHistorySummary(filter);
    const total = allEntries.length;

    const reversed = [...allEntries].reverse();
    const start = (page - 1) * pageSize;
    const slice = reversed.slice(start, start + pageSize);

    const entries = slice.map((entry: any, idx: number) => ({
      ...entry,
      index: total - start - idx,
    }));

    return { entries, total, page, pageSize };
  });

  if (!result.ok) {
    return respondBurpFailure(
      res,
      result,
      "[burp] Proxy history error:",
      "Failed to fetch proxy history",
      result.reason === "not-configured" ? { notConfigured: true } : {}
    );
  }

  return res.status(200).json(result.value);
};

export const getBurpProxyEntry = async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    return res.status(400).json({ message: "Invalid entry ID" });
  }

  const result = await withBurpClient(async (burp) => {
    const entry = await burp.proxy.getEntry(entryId);

    const entryResult: any = {
      id: entry.id,
      host: entry.request?.httpService?.host || "",
      port: entry.request?.httpService?.port || 0,
      secure: entry.request?.httpService?.secure || false,
      rawRequest: "",
      rawResponse: "",
    };

    if (entry.request?.rawBytesBase64) {
      entryResult.rawRequest = await decodeBurpBody(entry.request.rawBytesBase64);
    }

    if (entry.response?.rawBytesBase64) {
      entryResult.rawResponse = await decodeBurpBody(entry.response.rawBytesBase64);
    }

    return entryResult;
  });

  if (!result.ok) {
    return respondBurpFailure(
      res,
      result,
      "[burp] Proxy entry error:",
      "Failed to fetch proxy entry",
      result.reason === "not-configured" ? { notConfigured: true } : {}
    );
  }

  return res.status(200).json(result.value);
};

export const sendBurpRequest = async (req: Request, res: Response) => {
  const { host, port, secure, rawRequest } = req.body;
  if (!host || !rawRequest) {
    return res.status(400).json({ message: "host and rawRequest are required" });
  }

  const result = await withBurpClient((burp) =>
    sendRawHttpRequest(burp, { host, port, secure, rawRequest })
  );

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Send request error:", "Failed to send request");
  }

  return res.status(200).json(result.value);
};

export const sendToRepeater = async (req: Request, res: Response) => {
  const { host, port, secure, rawRequest, tabName } = req.body;
  if (!host || !rawRequest) {
    return res.status(400).json({ message: "host and rawRequest are required" });
  }

  const result = await withBurpClient(async (burp) => {
    const b64 = await encodeBurpBody(normalizeHttpRequest(rawRequest));
    await burp.repeater.sendToRepeater(
      {
        httpService: { host, port: port || 443, secure: secure ?? true },
        rawBytesBase64: b64,
      },
      tabName || ""
    );
    return { message: "Sent to Repeater" };
  });

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Send to repeater error:", "Failed to send to Repeater");
  }

  return res.status(200).json(result.value);
};

export const sendToIntruder = async (req: Request, res: Response) => {
  const { host, port, secure, rawRequest, tabName, insertionPoints } = req.body;
  if (!host || !rawRequest) {
    return res.status(400).json({ message: "host and rawRequest are required" });
  }

  const result = await withBurpClient(async (burp) => {
    const b64 = await encodeBurpBody(normalizeHttpRequest(rawRequest));
    await burp.intruder.sendToIntruder(
      host,
      port || 443,
      secure ?? true,
      b64,
      tabName || "",
      insertionPoints || []
    );
    return { message: "Sent to Intruder" };
  });

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Send to intruder error:", "Failed to send to Intruder");
  }

  return res.status(200).json(result.value);
};

export const sendAndReceiveRepeater = async (req: Request, res: Response) => {
  const { host, port, secure, rawRequest } = req.body;
  if (!host || !rawRequest) {
    return res.status(400).json({ message: "host and rawRequest are required" });
  }

  const result = await withBurpClient(async (burp) => {
    const b64 = await encodeBurpBody(normalizeHttpRequest(rawRequest));
    const sendResult = await burp.repeater.sendAndReceive(host, port || 443, secure ?? true, b64);
    return decodeBurpReply(sendResult);
  });

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Repeater send error:", "Failed to send via Repeater");
  }

  return res.status(200).json(result.value);
};

export const generateCollaboratorPayload = async (req: Request, res: Response) => {
  const { customData } = req.body || {};

  const result = await withBurpClient((burp) => burp.collaborator.generatePayload(customData || ""));

  if (!result.ok) {
    return respondBurpFailure(
      res,
      result,
      "[burp] Collaborator generate error:",
      "Failed to generate Collaborator payload"
    );
  }

  return res.status(200).json(result.value);
};

export const pollCollaborator = async (req: Request, res: Response) => {
  const { secretKey } = req.body;
  if (!secretKey) {
    return res.status(400).json({ message: "secretKey is required" });
  }

  const result = await withBurpClient((burp) => burp.collaborator.poll(secretKey));

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Collaborator poll error:", "Failed to poll Collaborator");
  }

  return res.status(200).json({ interactions: result.value });
};

export const getProxyInterceptStatus = async (_req: Request, res: Response) => {
  const result = await withBurpClient((burp) => burp.proxy.isInterceptEnabled());

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Intercept status error:", "Failed to get intercept status");
  }

  return res.status(200).json({ enabled: result.value });
};

export const setProxyIntercept = async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ message: "enabled (boolean) is required" });
  }

  const result = await withBurpClient((burp) => burp.proxy.setIntercept(enabled).then(() => ({ enabled })));

  if (!result.ok) {
    return respondBurpFailure(res, result, "[burp] Set intercept error:", "Failed to set intercept");
  }

  return res.status(200).json(result.value);
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

