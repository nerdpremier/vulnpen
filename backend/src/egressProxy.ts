/**
 * The egress fence, as a process.
 *
 * An HTTP proxy that refuses to forward a request the engagement's policy
 * forbids. The point is not the inspection — `egressPolicy` owns that — it is
 * the *position*: the attack box is given no route to anything except this
 * process, so every tool the agent can reach (`curl`, `python`, `nmap`,
 * `sqlmap`, a browser, a binary it just compiled) is judged by the same rules on
 * the same wire request. Command obfuscation buys nothing, because nothing here
 * reads the command.
 *
 * TLS is refused by default. A CONNECT tunnel is opaque, so a fence that lets
 * one through is not a fence for anything the client sends inside it — that is
 * the whole reason the fence exists. Enable `EGRESS_ALLOW_TLS=1` only when the
 * box trusts a CA the proxy can terminate with (the bundled Burp CA is
 * auto-trusted by `burp-ca.service.ts`), which turns the tunnel back into
 * inspectable requests.
 *
 * Usage:
 *   EGRESS_ALLOWLIST="juice-shop:3000,10.0.0.5" pnpm exec tsx src/egressProxy.ts
 *
 * Env:
 *   EGRESS_ALLOWLIST   comma-separated hosts the fence lets through
 *   EGRESS_TARGET      the engagement Target, used to derive the allowlist
 *   EGRESS_SCOPE       the engagement Scope free text
 *   EGRESS_PORT        listen port (default 3128)
 *   EGRESS_ALLOW_TLS   "1" to permit CONNECT tunnels (opaque — see above)
 */

import http from "node:http";
import net from "node:net";
import { isHostInScope } from "./utils/scopeGate";
import {
  allowlistFromTarget,
  assertEgressProxyArmed,
  decideEgressRequest,
} from "./utils/egressPolicy";

const DEFAULT_MAX_BODY = 1_048_576;

export function egressAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = (env.EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  return allowlistFromTarget(env.EGRESS_TARGET, env.EGRESS_SCOPE);
}

function deny(res: http.ServerResponse, status: number, rule: string, reason: string): void {
  const payload = JSON.stringify({ blocked: true, rule, reason });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload);
  console.warn(`[egress] blocked ${rule}: ${reason}`);
}

export function createEgressProxy(options: {
  allowlist: string[];
  allowTls?: boolean;
  maxBody?: number;
}) {
  const { allowlist } = options;
  const allowTls = options.allowTls === true;
  const maxBody = options.maxBody ?? DEFAULT_MAX_BODY;

  const server = http.createServer((req, res) => {
    const absolute = req.url?.startsWith("http");
    let host = "";
    let port = 80;
    let path = req.url ?? "/";
    try {
      if (absolute) {
        const parsed = new URL(req.url!);
        // A TLS request cannot be forwarded in the clear to port 443, and a
        // tunnel is opaque: neither can be judged, so neither leaves.
        if (parsed.protocol !== "http:") {
          return deny(res, 400, "egress:opaque-tls", "คำขอ HTTPS ตรวจสอบไม่ได้");
        }
        host = parsed.hostname;
        port = Number(parsed.port) || 80;
        path = parsed.pathname + parsed.search;
      } else {
        const [name, portText] = (req.headers.host ?? "").split(":");
        host = name;
        port = Number(portText) || 80;
      }
    } catch {
      return deny(res, 400, "egress:malformed", "คำขออ่านไม่ได้");
    }

    // A body the fence cannot read is a body it cannot judge. Compressed bodies
    // hide a statement from the rules, so they are refused rather than guessed at.
    const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      req.resume();
      return deny(res, 415, "egress:opaque-encoding", `Content-Encoding ${encoding} ตรวจสอบไม่ได้`);
    }

    // The body is read in full before the verdict: a destructive statement can
    // live anywhere in the payload of an otherwise ordinary POST, and what is
    // forwarded must be exactly what was judged.
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBody) {
        refused = true;
        chunks.length = 0;
        deny(res, 413, "egress:body-too-large", `เนื้อหาคำขอเกิน ${maxBody} ไบต์ จึงตรวจสอบไม่ครบ`);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      const payload = Buffer.concat(chunks);
      const decision = decideEgressRequest(
        {
          method: req.method ?? "GET",
          url: path,
          host,
          body: payload.toString("utf8"),
          headers: req.headers,
        },
        allowlist,
      );
      if (!decision.allow) return deny(res, 403, decision.rule, decision.reason);

      // Forward to the authority that was judged, with the headers the client
      // sent minus the ones that describe the hop to this proxy.
      const headers = { ...req.headers };
      for (const name of Object.keys(headers)) {
        if (name.startsWith("proxy-")) delete headers[name];
      }
      delete headers["transfer-encoding"];
      delete headers["content-length"];
      headers.host = port === 80 ? host : `${host}:${port}`;
      if (payload.length || !["GET", "HEAD", "OPTIONS", "TRACE"].includes(req.method ?? "GET")) {
        headers["content-length"] = String(payload.length);
      }

      const upstream = http.request(
        { host, port, path, method: req.method, headers },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("error", (error) => deny(res, 502, "egress:upstream", String(error.message)));
      upstream.end(payload);
    });
  });

  // A protocol upgrade (WebSocket) turns the connection into an opaque stream.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 403 Forbidden" + String.fromCharCode(13, 10, 13, 10));
    console.warn("[egress] blocked egress:opaque-upgrade");
  });

  server.on("connect", (req, clientSocket, head) => {
    const [host, portText] = (req.url ?? "").split(":");
    const port = Number(portText) || 443;

    // Scope is checked on the CONNECT authority: there is no URL to parse.
    if (!isHostInScope(host ?? "", allowlist)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      console.warn(`[egress] blocked egress:out-of-scope CONNECT ${req.url}`);
      return;
    }
    if (!allowTls) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      console.warn(
        `[egress] blocked egress:opaque-tls CONNECT ${req.url} — a tunnel cannot be inspected; ` +
          "set EGRESS_ALLOW_TLS=1 only with a CA the proxy can terminate with",
      );
      return;
    }

    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.end());
  });

  return server;
}

function main() {
  const config = { allowlist: egressAllowlist(), port: Number(process.env.EGRESS_PORT) || 3128 };
  // Refuse to run unarmed: the box has no other route, so an unarmed fence that
  // serves traffic is worse than no fence at all.
  assertEgressProxyArmed(config);
  const server = createEgressProxy({ allowlist: config.allowlist, allowTls: process.env.EGRESS_ALLOW_TLS === "1" });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `[egress] fence listening on :${config.port} — ${config.allowlist.length} host(s) allowed, ` +
        `TLS ${process.env.EGRESS_ALLOW_TLS === "1" ? "tunnelled (NOT inspected)" : "refused"}`,
    );
  });
}

if (require.main === module) {
  main();
}
