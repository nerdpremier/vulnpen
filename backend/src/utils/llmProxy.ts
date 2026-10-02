/**
 * Signed LLM pass-through for the Magnitude browser agent.
 *
 * Magnitude 0.3.1's BAML client exposes no reasoning-effort knob, so when a
 * browser preset carries a reasoningMode we point its base_url at this proxy.
 * The proxy verifies an HMAC signature, injects `reasoning_effort` into the
 * JSON body and forwards the request (including SSE streams) to the real
 * provider. Without a signature no target is trusted — the URL is the only
 * credential the in-container agent needs.
 */

import crypto from "crypto";
import { Router, Request, Response } from "express";
import getSecrets from "./getSecrets";

export const LLM_PROXY_PREFIX = "/api/agent/llm-proxy";

interface ProxyPayload {
  t: string;
  e: string;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function buildProxiedBaseUrl(
  target: string,
  effort: string,
): Promise<string> {
  const secret = (await getSecrets("SESS_SECRET")) as string;
  const payload = Buffer.from(
    JSON.stringify({ t: target, e: effort } satisfies ProxyPayload),
  ).toString("base64url");
  const selfOrigin = `http://127.0.0.1:${process.env.PORT || "8080"}`;
  return `${selfOrigin}${LLM_PROXY_PREFIX}/${payload}/${sign(payload, secret)}`;
}

const FORWARDED_HEADERS = ["authorization", "content-type", "accept", "user-agent"];

export const llmProxyRouter = Router();

llmProxyRouter.use("/:payload/:sig", async (req: Request, res: Response) => {
  try {
    const secret = (await getSecrets("SESS_SECRET")) as string;
    const { payload, sig } = req.params;
    const expected = sign(payload, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ message: "Invalid proxy signature" });
    }

    let target: string;
    let effort: string;
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as ProxyPayload;
      target = decoded.t;
      effort = decoded.e;
    } catch {
      return res.status(400).json({ message: "Invalid proxy payload" });
    }
    if (!/^https?:\/\//.test(target)) {
      return res.status(400).json({ message: "Invalid proxy target" });
    }

    // Inside this use()-mounted router req.url is the request path relative to
    // "/:payload/:sig" — e.g. "/chat/completions" plus any query. req.params[0]
    // is never populated for a use() mount, so reading it forwarded every call
    // to the bare provider root and the provider answered 404.
    const url = `${target}${req.url}`;

    // express.json upstream gives us the parsed body; re-serialize with the
    // reasoning effort injected. Non-object bodies pass through untouched.
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const parsed = req.body;
      if (effort && effort !== "off" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsed.reasoning_effort = effort;
      }
      body = parsed === undefined ? undefined : JSON.stringify(parsed);
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (body !== undefined) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
    }

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);

    if (!upstream.body) {
      return res.end();
    }
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err: any) {
    console.error("[llm-proxy] error:", err?.message ?? err);
    if (!res.headersSent) {
      res.status(502).json({ message: "LLM proxy request failed" });
    } else {
      res.end();
    }
  }
});
