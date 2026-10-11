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
 * TLS is refused by default. A CONNECT tunnel is opaque — everything inside it
 * is encrypted between the client and the real destination, so nothing here
 * can read it to judge it. `EGRESS_ALLOW_TLS=1` does not tunnel it blindly:
 * this process terminates the TLS itself (`utils/egressCa.ts` signs a
 * per-host leaf certificate from a CA generated on first boot and persisted to
 * `/kali-data/egress-ca`), decrypts, and hands the plaintext HTTP request to
 * the exact same request handler — and therefore the exact same
 * `decideEgressRequest` judging — that already governs plain HTTP. HTTPS gets
 * the same guarantees HTTP already has; it does not trade them away. The box
 * has to be made to trust that CA for this to work without every client
 * erroring on an unknown certificate — `egress-ca-trust.service.ts` does that.
 *
 * Usage:
 *   EGRESS_ALLOWLIST="juice-shop:3000,10.0.0.5" pnpm exec tsx src/egressProxy.ts
 *
 * Env:
 *   EGRESS_ALLOWLIST   comma-separated hosts the fence lets through
 *   EGRESS_TARGET      the engagement Target, used to derive the allowlist
 *   EGRESS_SCOPE       the engagement Scope free text
 *   EGRESS_PORT        listen port (default 3128)
 *   EGRESS_ALLOW_TLS   "1" to terminate and judge CONNECT tunnels (see above)
 *   EGRESS_CA_DIR      where the fence's CA lives (default /kali-data/egress-ca)
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { isHostInScope, isPublicInternetHost } from "./utils/scopeGate";
import {
  allowlistFromTarget,
  assertEgressProxyArmed,
  decideEgressRequest,
} from "./utils/egressPolicy";
import {
  EGRESS_CA_DIR,
  caCertificateDer,
  createLeafSigner,
  loadOrCreateCa,
} from "./utils/egressCa";

const DEFAULT_MAX_BODY = 1_048_576;
/** Served unauthenticated, mirroring Burp's own `/cert` export endpoint. */
const CA_CERT_PATH = "/__egress_ca__/ca.der";

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

interface EgressSocket extends net.Socket {
  /** True on a socket a MITM'd CONNECT has wrapped in TLS, i.e. the request
   *  inside the tunnel is HTTPS and has to be re-encrypted upstream. */
  encrypted?: boolean;
  /** Set only on the decrypted socket a MITM'd CONNECT hands to this server —
   *  the real port the client asked to CONNECT to, for Host headers that omit
   *  it (the common case: a browser leaves out :443). */
  connectPort?: number;
}

/** An IPv4/IPv6 literal, which must not be sent as a TLS SNI servername. */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":") && /^[0-9a-f:]+$/i.test(host);
}

export function createEgressProxy(options: {
  allowlist: string[];
  allowTls?: boolean;
  maxBody?: number;
  caDir?: string;
  /** Extra roots for the upstream (destination) leg. Only tests set this —
   *  the egress process itself never does, so a real destination always has
   *  to validate against the system trust store. */
  upstreamCa?: string | Buffer | Array<string | Buffer>;
}) {
  const { allowlist } = options;
  const allowTls = options.allowTls === true;
  const maxBody = options.maxBody ?? DEFAULT_MAX_BODY;
  const caDir = options.caDir ?? EGRESS_CA_DIR;
  const upstreamCa = options.upstreamCa;

  // Lazy: the CA touches the filesystem (`/kali-data` in production), and the
  // overwhelming majority of callers — every plain-HTTP request, every test
  // that never exercises TLS — never need it at all.
  let caState: { der: Buffer; sign: (host: string) => { cert: string; key: string } } | null = null;
  const ensureCa = () => {
    if (!caState) {
      const ca = loadOrCreateCa(caDir);
      caState = { der: caCertificateDer(ca), sign: createLeafSigner(ca) };
    }
    return caState;
  };

  const server = http.createServer((req, res) => {
    // Unauthenticated on purpose, like Burp's own `/cert` export: this is a
    // public CA certificate, meant to be installed widely, not a secret.
    if (req.url === CA_CERT_PATH) {
      const der = ensureCa().der;
      res.writeHead(200, {
        "content-type": "application/pkix-cert",
        "content-length": der.length,
      });
      res.end(der);
      return;
    }

    const encrypted = Boolean((req.socket as EgressSocket).encrypted);
    const defaultPort = encrypted ? (req.socket as EgressSocket).connectPort || 443 : 80;
    const absolute = req.url?.startsWith("http");
    let host = "";
    let port = defaultPort;
    let path = req.url ?? "/";
    try {
      if (absolute) {
        const parsed = new URL(req.url!);
        // A TLS request cannot be forwarded in the clear to port 443, and a
        // tunnel is opaque: neither can be judged, so neither leaves. (This
        // branch only ever sees plain-HTTP proxy requests — a MITM'd CONNECT
        // tunnel always carries origin-form requests, handled below.)
        if (parsed.protocol !== "http:") {
          return deny(res, 400, "egress:opaque-tls", "คำขอ HTTPS ตรวจสอบไม่ได้");
        }
        host = parsed.hostname;
        port = Number(parsed.port) || 80;
        path = parsed.pathname + parsed.search;
      } else {
        const [name, portText] = (req.headers.host ?? "").split(":");
        host = name;
        port = Number(portText) || defaultPort;
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

      const replyHandler = (reply: http.IncomingMessage) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      };

      // An HTTPS request inside a terminated tunnel is re-encrypted upstream as
      // a normal, fully-validated outbound TLS connection: only the client-facing
      // leg is intercepted. The plain-HTTP leg is untouched.
      const upstream = encrypted
        ? https.request(
            {
              host,
              port,
              path,
              method: req.method,
              headers,
              // SNI only makes sense for a name: sending an address literal as
              // servername is rejected by OpenSSL. Node still validates the
              // destination's certificate against `host` either way.
              ...(isIpLiteral(host) ? {} : { servername: host }),
              rejectUnauthorized: true,
              ...(upstreamCa ? { ca: upstreamCa } : {}),
            },
            replyHandler,
          )
        : http.request({ host, port, path, method: req.method, headers }, replyHandler);
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
    // A host that is neither in the engagement allowlist nor plainly public
    // infrastructure (a docker name, an RFC1918 address, an internal suffix)
    // is refused outright — no TLS is attempted for something the fence would
    // refuse to judge anyway.
    if (!isHostInScope(host ?? "", allowlist) && !isPublicInternetHost(host ?? "")) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      console.warn(`[egress] blocked egress:out-of-scope CONNECT ${req.url}`);
      return;
    }
    if (!allowTls) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      console.warn(
        `[egress] blocked egress:opaque-tls CONNECT ${req.url} — a tunnel cannot be inspected; ` +
          "set EGRESS_ALLOW_TLS=1 to terminate TLS with the fence's CA and judge what is inside",
      );
      return;
    }

    // Terminate the client's TLS here. The decrypted socket is handed to this
    // same server, so the request inside the tunnel hits the exact same handler
    // — and the exact same decideEgressRequest — as a plain-HTTP request.
    const leaf = ensureCa().sign(host);
    const tlsServer = tls.createServer({
      cert: leaf.cert,
      key: leaf.key,
      // Force HTTP/1.1: the plaintext request must be one this server's HTTP/1.x
      // parser can read. HTTP/2 would bypass the handler entirely.
      ALPNProtocols: ["http/1.1"],
    });
    tlsServer.on("secureConnection", (decrypted) => {
      // The common case: the client's Host header omits :443. It has to default
      // the way the client's request line did, which this CONNECT's port is.
      (decrypted as EgressSocket).connectPort = port;
      server.emit("connection", decrypted);
    });
    tlsServer.on("tlsClientError", (_error, raw) => raw.destroy());

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) clientSocket.unshift(head);
    tlsServer.emit("connection", clientSocket);
  });

  return server;
}

function main() {
  const config = { allowlist: egressAllowlist(), port: Number(process.env.EGRESS_PORT) || 3128 };
  // Refuse to run unarmed: the box has no other route, so an unarmed fence that
  // serves traffic is worse than no fence at all.
  assertEgressProxyArmed(config);
  const allowTls = process.env.EGRESS_ALLOW_TLS === "1";
  const caDir = (process.env.EGRESS_CA_DIR ?? "").trim() || EGRESS_CA_DIR;
  // Materialise the CA at boot, not lazily on the first tunnel: the backend's
  // trust installer reads ca.crt off the shared mount and cannot install what
  // does not exist yet, so a fresh stack must not depend on some request having
  // happened to arrive first.
  if (allowTls) loadOrCreateCa(caDir);
  const server = createEgressProxy({ allowlist: config.allowlist, allowTls, caDir });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `[egress] fence listening on :${config.port} — ${config.allowlist.length} host(s) allowed, ` +
        `TLS ${allowTls ? `terminated and judged (CA at ${caDir})` : "refused"}`,
    );
  });
}

if (require.main === module) {
  main();
}
