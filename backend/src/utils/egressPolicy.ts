/**
 * The egress fence: one decision, made on the wire.
 *
 * Every other boundary in VulnPen reads the *command* the agent is about to run
 * (`targetSafety`), which means it is reading a language the agent also
 * controls: `curl -X DELETE …`, `python` calling `requests.delete`, `echo cm0 |
 * base64 -d | sh` in the browser or Burp. Those all reduce to the same HTTP
 * request in the end.
 *
 * This module decides on that request instead. The rules are the ones already
 * defined for the target (`detectDestructiveTargetAction`) and for scope
 * (`checkScope`) — nothing new is invented here. What changes is *where* they
 * run: at a chokepoint the agent cannot route around, so the obfuscation that
 * defeats a text rule buys nothing. `curl`, `python`, a compiled binary, the
 * browser and Burp all produce the same request line, and it is judged the same
 * way.
 *
 * What this guarantees, and what it does not:
 *   - 100%: a request to a host outside the allowlist does not leave.
 *   - 100%: a request whose method is DELETE does not leave.
 *   - Best effort: "this POST removes data" is a judgement about meaning, and a
 *     novel endpoint name will not be recognised. The chokepoint removes the
 *     *evasion* problem, not the *semantics* problem.
 */

import { detectDestructiveTargetAction, hasDeleteEndpoint } from "./targetSafety";
import {
  LOCAL_HOSTS,
  checkScope,
  isHostInScope,
  isPublicInternetHost,
  parseScopeHosts,
} from "./scopeGate";

export interface EgressRequest {
  method: string;
  /** Absolute URL when the client used one, otherwise the origin-form path. */
  url: string;
  /** The host the client addressed, from the URL or the Host header. */
  host: string;
  /** The whole body. The caller must refuse a body it could not read in full. */
  body?: string;
  /** Request headers: a method override travels here, not in the request line. */
  headers?: Record<string, string | string[] | undefined>;
}

export type EgressDecision =
  | { allow: true }
  | { allow: false; rule: string; reason: string };

const ALLOW: EgressDecision = { allow: true };

/**
 * The allowlist a proxy enforces. It is built from the engagement's declared
 * Target — the same field that arms the deterministic scope gate — so there is
 * one definition of "in scope" in the product, not two.
 *
 * With neither a Target nor a scope declared there is no allowlist, and this
 * returns empty on purpose. `parseScopeHosts` always seeds LOCAL_HOSTS, so
 * falling through to it would hand the fence a non-empty list made only of
 * localhost: `assertEgressProxyArmed` would pass, the fence would serve, and
 * every request to the real target would be refused as out-of-scope while the
 * "an unarmed fence must not start" guard never fired. Empty is the honest
 * answer — the caller is expected to refuse to serve.
 */
export function allowlistFromTarget(target?: string, scope?: string): string[] {
  if (!target?.trim() && !scope?.trim()) return [];
  return parseScopeHosts(scope, target);
}

/**
 * True when the allowlist names a host that is not a local address — i.e. the
 * engagement actually declared a target. A list of only local hosts is not an
 * armed fence, it is the seed `parseScopeHosts` adds for free.
 */
export function hasDeclaredTarget(allowlist: string[]): boolean {
  return allowlist.some((host) => !LOCAL_HOSTS.has(host.toLowerCase()));
}

/**
 * Headers a browser attaches automatically and that are never a connection
 * target: Chrome's own User-Agent is frozen to a `<major>.0.0.0` form (its
 * User-Agent Reduction policy — "Chrome/150.0.0.0" is the real value sent by
 * every request a current Chromium makes), which is a dotted quad `IPV4_RE`
 * cannot tell apart from an actual address. Scanning them for IP literals
 * finds the browser's own version number, not a host the request names —
 * false-flagging a legitimate request to the in-scope host.
 */
const CLIENT_METADATA_HEADERS = new Set([
  "user-agent",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-wow64",
]);

/** The request as a wire line, which is what the target rules already read. */
function asWireRequest(request: EgressRequest): string {
  const path = request.url.startsWith("http")
    ? (() => {
        try {
          return new URL(request.url).pathname + new URL(request.url).search;
        } catch {
          return request.url;
        }
      })()
    : request.url;
  const headers = Object.entries(request.headers ?? {})
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== "host" && !CLIENT_METADATA_HEADERS.has(lower);
    })
    .map(([name, value]) => `\n${name}: ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`)
    .join("");
  const body = request.body ? `\n\n${request.body}` : "";
  return `${request.method.toUpperCase()} ${path} HTTP/1.1\nHost: ${request.host}${headers}${body}`;
}

/** The request line's path and query, which is what names an endpoint. */
function requestTarget(request: EgressRequest): string {
  if (!request.url.startsWith("http")) return request.url;
  try {
    const parsed = new URL(request.url);
    return parsed.pathname + parsed.search;
  } catch {
    return request.url;
  }
}

/** Methods that read. A request that changes state on the other end is not a read. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The only methods that may leave. Anything else (WebDAV MOVE / COPY / MKCOL /
 * PROPPATCH / LOCK, a cache PURGE, an invented verb) either removes or rewrites
 * a resource or has no place in a web-application test; a method is a token, so
 * this is exact. DELETE is absent on purpose and is named by its own rule first.
 */
const ALLOWED_METHODS = new Set([...READ_METHODS, "TRACE", "POST", "PUT", "PATCH"]);

function percentDecode(text: string): string {
  return text
    .replace(/\+/g, " ")
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
    });
}

function unicodeUnescape(text: string): string {
  return text.replace(/\\u([0-9a-f]{4})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The server decodes the request before acting on it, so the rules have to read
 * what the server will read: `DELETE%20FROM`, `/%64elete`, `"DELETE FROM"`
 * and a doubly-encoded form are all the same request as their plain spelling.
 */
function wireVariants(text: string): string[] {
  const unescaped = unicodeUnescape(text);
  const once = percentDecode(unescaped);
  const twice = percentDecode(once);
  return [...new Set([text, unescaped, once, twice])];
}

/**
 * Decide one request.
 *
 * The engagement target is on the public internet, so the fence cannot be a
 * blanket allowlist: the box still has to install tools and look things up, and
 * both are reads. What it can be is a rule that every *state-changing* request
 * is judged, and that nothing outside the engagement is written to at all.
 *
 * `allowlist` is the engagement's target hosts. An empty one means no Target was
 * declared; the caller is expected to refuse to serve at all in that case (see
 * `assertEgressProxyArmed`).
 */
export function decideEgressRequest(
  request: EgressRequest,
  allowlist: string[],
): EgressDecision {
  const method = (request.method || "GET").toUpperCase();
  const wire = asWireRequest({ ...request, method });

  // 1. Destructive first, whatever the destination: this is the guarantee the
  //    fence exists for, and it is read off the request rather than a command.
  for (const variant of wireVariants(wire)) {
    const destructive = detectDestructiveTargetAction(variant);
    if (destructive.dangerous) {
      return { allow: false, rule: destructive.rule, reason: destructive.reason };
    }
  }

  if (!ALLOWED_METHODS.has(method)) {
    return {
      allow: false,
      rule: "egress:method",
      reason: `เมธอด ${method} ไม่อยู่ในชุดที่อนุญาตให้ออกไปยังเป้าหมาย`,
    };
  }

  const reads = READ_METHODS.has(method);

  // 2. Outside the engagement: reading the public internet is reconnaissance,
  //    not engagement activity, so a tool download or an OSINT lookup passes.
  //    Anything that writes, or that addresses an internal or unidentifiable
  //    host, does not.
  if (!isHostInScope(request.host, allowlist)) {
    if (reads && isPublicInternetHost(request.host)) return ALLOW;
    return {
      allow: false,
      rule: "egress:out-of-scope",
      reason: `คำขอจะออกไปยัง ${request.host} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
    };
  }

  // 2b. Inside the engagement, an endpoint that is a removal operation is refused
  //     whatever the method: a GET that deletes is still a delete, and the verb
  //     rules only see a write verb.
  for (const variant of wireVariants(requestTarget(request))) {
    if (hasDeleteEndpoint(variant)) {
      return {
        allow: false,
        rule: "http:delete-endpoint",
        reason: "เรียกปลายทางที่ทำหน้าที่ลบหรือปิดการใช้งานข้อมูลบนเป้าหมาย",
      };
    }
  }

  // 3. Inside the engagement, a host named in the request still crosses the
  //    boundary: the destination would reach it on our behalf. The same
  //    public-read exemption applies — an OSINT lookup by address is part of the
  //    one request, not a second connection.
  const { outside } = checkScope(wire, allowlist);
  const crossing = outside.filter((host) => !(reads && isPublicInternetHost(host)));
  if (crossing.length) {
    return {
      allow: false,
      rule: "egress:out-of-scope",
      reason: `คำขออ้างถึง ${crossing.join(", ")} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
    };
  }

  return ALLOW;
}

export interface EgressProxyConfig {
  /** Hosts the fence lets through. Empty means "not armed". */
  allowlist: string[];
  /** Port the proxy listens on. */
  port: number;
}

/**
 * An unarmed fence must refuse to run rather than pass everything: the box is
 * configured with no other route, so refusing to serve is the difference
 * between "no traffic" and "uninspected traffic".
 */
export function assertEgressProxyArmed(config: EgressProxyConfig): void {
  if (!hasDeclaredTarget(config.allowlist)) {
    throw new Error(
      "Egress fence is not armed: no declared Target, so no allowlist. " +
        "Set EGRESS_ALLOWLIST (or pass EGRESS_TARGET / EGRESS_SCOPE) before starting the proxy — " +
        "an unarmed fence would pass every request uninspected.",
    );
  }
}
