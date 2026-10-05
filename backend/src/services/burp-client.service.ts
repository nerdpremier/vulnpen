import { readEnvFile } from "../utils/envWriter";

type BurpRpcModule = typeof import("burp-rpc");

export type BurpClient = InstanceType<BurpRpcModule["BurpClient"]>;

export type BurpRpcConfig = { host: string; port: number };

export type OpenedBurpClient =
  | { ok: true; client: BurpClient; config: BurpRpcConfig }
  | { ok: false; reason: "not-configured" };

// Burp may be on a remote host; the 500 ms library default for ping() is
// too tight for anything past a LAN round trip.
export const BURP_PING_TIMEOUT_MS = 5000;

export const BURP_NOT_CONFIGURED_MSG =
  "Burp RPC is not configured. Set BURP_RPC_HOST and BURP_RPC_PORT in Settings.";

export const BURP_DISCONNECTED_MSG =
  "Burp Suite appears to be disconnected. " +
  "Please verify the Burp RPC extension is loaded and running, " +
  "and check your host/port configuration in Settings.";

/**
 * The single place that knows how to reach Burp RPC: where the host/port
 * live, the default port, and what "not configured" means. Everything else
 * goes through openBurpClient() and closes the client it is given.
 */
export function getBurpRpcConfig(): BurpRpcConfig | null {
  const env = readEnvFile();
  const host = env.BURP_RPC_HOST;
  if (!host || !String(host).trim()) return null;
  return { host, port: parseInt(env.BURP_RPC_PORT || "50051", 10) };
}

export async function openBurpClient(): Promise<OpenedBurpClient> {
  const config = getBurpRpcConfig();
  if (!config) return { ok: false, reason: "not-configured" };

  const { BurpClient } = await import("burp-rpc");
  return {
    ok: true,
    client: new BurpClient({ host: config.host, port: config.port }),
    config,
  };
}

export function isBurpUnreachable(err: any): boolean {
  return err?.code === 14 || err?.code === 4;
}

export type BurpCallFailure =
  | { ok: false; reason: "not-configured"; message: string }
  | { ok: false; reason: "unreachable"; message: string; config: BurpRpcConfig }
  | { ok: false; reason: "error"; message: string; error: unknown };

export type BurpCallResult<T> = { ok: true; value: T } | BurpCallFailure;

/**
 * Runs fn with an opened Burp client and owns the whole lifecycle: open,
 * close (even on failure), and reachability triage. Callers get back either
 * a value or a structured failure — they never touch client.close(), gRPC
 * error codes, or the not-configured check themselves.
 */
export async function withBurpClient<T>(
  fn: (client: BurpClient, config: BurpRpcConfig) => Promise<T>
): Promise<BurpCallResult<T>> {
  let client: BurpClient | undefined;
  let config: BurpRpcConfig | undefined;
  try {
    const opened = await openBurpClient();
    if (!opened.ok) {
      return { ok: false, reason: "not-configured", message: BURP_NOT_CONFIGURED_MSG };
    }
    client = opened.client;
    config = opened.config;
    return { ok: true, value: await fn(opened.client, opened.config) };
  } catch (err: any) {
    if (isBurpUnreachable(err)) {
      return {
        ok: false,
        reason: "unreachable",
        config: config ?? { host: "?", port: 0 },
        message:
          (config
            ? `Could not connect to Burp Suite at ${config.host}:${config.port}. `
            : "Could not connect to Burp Suite. ") +
          "Verify the Burp RPC extension is loaded and running, " +
          "and check your host/port configuration in Settings.",
      };
    }
    return { ok: false, reason: "error", error: err, message: err?.message || String(err) };
  } finally {
    client?.close();
  }
}

// ─── Payload codec ───────────────────────────────────────────────────
// burp-rpc stays an implementation detail of this module: callers encode
// request bodies and decode raw bytes through these helpers instead of
// importing the library themselves.

export async function encodeBurpBody(raw: string): Promise<string> {
  const { encodeBase64Body } = await import("burp-rpc");
  return encodeBase64Body(raw);
}

export async function decodeBurpBody(base64: string): Promise<string> {
  const { decodeBase64Body } = await import("burp-rpc");
  return decodeBase64Body(base64);
}

/** Maps a withBurpClient failure to the error-output string a tool result expects. */
export function burpFailureToToolOutput(failure: BurpCallFailure, label: string): string {
  return failure.reason === "error" ? `Error ${label}: ${failure.message}` : `Error: ${failure.message}`;
}

/**
 * Textareas normalize \r\n to \n; HTTP requires \r\n. Recalculate
 * Content-Length to match the actual body after normalization.
 */
export function normalizeHttpRequest(rawRequest: string): string {
  const normalized = rawRequest.replace(/\r?\n/g, "\r\n");
  const headerBodySplit = normalized.indexOf("\r\n\r\n");
  if (headerBodySplit === -1) return normalized;

  const headersPart = normalized.substring(0, headerBodySplit);
  const bodyPart = normalized.substring(headerBodySplit + 4);
  const bodyLength = Buffer.byteLength(bodyPart, "utf-8");
  return (
    headersPart.replace(/Content-Length:\s*\d+/i, `Content-Length: ${bodyLength}`) +
    "\r\n\r\n" +
    bodyPart
  );
}

export type BurpHttpReply = { hasResponse: boolean; rawResponse: string };

type BurpSendResult = { hasResponse: boolean; response?: { rawBytesBase64?: string } };

export async function decodeBurpReply(sendResult: BurpSendResult): Promise<BurpHttpReply> {
  const rawResponse = sendResult?.response?.rawBytesBase64
    ? await decodeBurpBody(sendResult.response.rawBytesBase64)
    : "";
  return { hasResponse: sendResult?.hasResponse ?? !!rawResponse, rawResponse };
}

/**
 * Sends a raw HTTP request through Burp's HTTP engine and decodes the reply.
 * Owns the normalize-then-send-then-decode sequence that the controller and
 * the send_to_burp_repeater tool both need, so it exists in exactly one place.
 */
export async function sendRawHttpRequest(
  burp: BurpClient,
  opts: { host: string; port?: number; secure?: boolean; rawRequest: string }
): Promise<BurpHttpReply> {
  const sendResult = await burp.http.sendRawRequest(
    opts.host,
    opts.port ?? 443,
    opts.secure ?? true,
    normalizeHttpRequest(opts.rawRequest),
  );
  return decodeBurpReply(sendResult);
}
