/**
 * Deterministic scope gate. Extracts network targets from a command or script
 * and checks them against the engagement allowlist before anything runs.
 * The LLM reviewer (auto_approve) is a second opinion, never the boundary.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "local"]);

const URL_RE = /\bhttps?:\/\/([a-zA-Z0-9._-]+|\[[0-9a-f:]+\])(:\d+)?(\/|\b|['"<>\s]|$)/gi;
const IPV4_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const URL_START_RE = /\bhttps?:\/\/\S+/gi;
const FLAG_TARGET_RE = /(?:^|\s)(?:-u|--url|--host|-t|--target|--upload-file)\s+['"]?([^\s'"]+)/gi;

/** Pull hostnames/IPs a command will connect to. Deliberately precise: URLs,
 *  IP literals, and explicit target flags — not every bare word. */
export function extractCommandHosts(text: string): string[] {
  if (!text) return [];
  const hosts = new Set<string>();
  for (const m of text.matchAll(URL_RE)) addHost(hosts, m[1]);
  for (const m of text.matchAll(FLAG_TARGET_RE)) {
    const raw = m[1].replace(/\/+$/, "");
    addHost(hosts, raw.replace(/^https?:\/\//i, "").split(/[/:]/)[0]);
  }
  // IP literals outside URLs. An address that only appears inside a URL path
  // or query (an OSINT lookup by address, say) is part of that one request, not
  // a second connection target. An address that is itself a URL host, including
  // one nested in a query parameter, is already captured by URL_RE above.
  const withoutUrls = text.replace(URL_START_RE, " ");
  for (const m of withoutUrls.matchAll(IPV4_RE)) addHost(hosts, m[1]);
  return [...hosts];
}

function addHost(hosts: Set<string>, host: string | undefined): void {
  if (!host) return;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || !h.includes(".") && h.length < 2) return;
  hosts.add(h);
}

/** Parse an allowlist out of the engagement scope/target free text: URLs,
 *  IPv4s and bare domain-like tokens. Local addresses are always allowed. */
export function parseScopeHosts(scope?: string, target?: string): string[] {
  const hosts = new Set<string>(LOCAL_HOSTS);
  const text = [scope, target].filter(Boolean).join(" ");
  for (const m of text.matchAll(URL_RE)) addHost(hosts, m[1]);
  for (const m of text.matchAll(IPV4_RE)) addHost(hosts, m[1]);
  for (const token of text.split(/[\s,;'"]+/)) {
    const t = token.toLowerCase().replace(/^https?:\/\//, "").split(/[/:]/)[0].replace(/\.$/, "");
    // Dotless entries (docker hostnames like juice-shop) are fine here — a
    // broad allowlist is safe because command extraction is precise.
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(t) && t.length >= 2) {
      hosts.add(t);
    }
  }
  return [...hosts];
}

export interface ScopeCheckResult {
  outside: string[];
  allowlist: string[];
}

/**
 * Fail-open on purpose: with no parseable allowlist there is nothing to check
 * against, so the deterministic gate abstains and the existing approval
 * pipeline (modes / LLM reviewer) stays in charge.
 */
export function checkScope(text: string, allowlist: string[]): ScopeCheckResult {
  // Fail-open on purpose: with no parseable allowlist there is nothing to
  // check against, so the deterministic gate abstains and the existing
  // approval pipeline (modes / LLM reviewer) stays in charge.
  if (!allowlist.length) return { outside: [], allowlist: [] };
  const allow = new Set([...LOCAL_HOSTS, ...allowlist.map((h) => h.toLowerCase())]);
  // A suffix rule covers subdomains of an in-scope domain (juice-shop:3000 etc.).
  const outside = extractCommandHosts(text).filter((host) => {
    if (allow.has(host)) return false;
    return !allowListCovers(allow, host);
  });
  return { outside, allowlist: [...allow] };
}

function allowListCovers(allow: Set<string>, host: string): boolean {
  for (const a of allow) {
    if (host === a || host.endsWith("." + a)) return true;
  }
  return false;
}

/** Non-local hosts actually declared by the engagement scope text. An empty
 *  result means the user never declared a reachable target, so the gate must
 *  abstain — LOCAL_HOSTS alone must not count as an allowlist. */
export function declaredScopeHosts(scope?: string, target?: string): string[] {
  const text = [scope, target].filter(Boolean).join(" ");
  if (!text.trim()) return [];
  const hosts = new Set<string>();
  for (const m of text.matchAll(URL_RE)) addHost(hosts, m[1]);
  for (const m of text.matchAll(IPV4_RE)) addHost(hosts, m[1]);
  for (const token of text.split(/[\s,;'"]+/)) {
    const raw = token.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const host = raw.split("/")[0].split(":")[0].replace(/\.$/, "");
    if (!host) continue;
    // Bare prose words ("Storefront", "REST") in the scope text must not look
    // like a declared target, so dotted domains only -- plus an explicit
    // host:port form (docker-style "juice-shop:3000"), which is unambiguous.
    const hostPort = /^[a-z0-9][a-z0-9.-]*:\d+$/.test(raw);
    const domainLike =
      raw.includes(".") &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw);
    if (hostPort || domainLike) hosts.add(host);
  }
  return [...hosts].filter((h) => !LOCAL_HOSTS.has(h));
}

/** Names that are never public internet: reserved, private or single-label
 *  (docker / k8s / NetBIOS). */
const PRIVATE_SUFFIXES = [
  ".local",
  ".localhost",
  ".localdomain",
  ".internal",
  ".intranet",
  ".corp",
  ".lan",
  ".home",
  ".test",
  ".example",
  ".invalid",
];
const PRIVATE_IP_RE =
  /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * True when a host is plainly reachable public infrastructure. Reading a public
 * page is reconnaissance; touching an internal or unidentifiable host is the
 * boundary crossing the engagement scope exists to catch.
 */
export function isPublicInternetHost(host: string): boolean {
  const h = host.toLowerCase();
  // No dot: a docker/k8s/NetBIOS name, never public DNS.
  if (!h.includes(".")) return false;
  if (PRIVATE_IP_RE.test(h)) return false;
  if (PRIVATE_SUFFIXES.some((suffix) => h.endsWith(suffix))) return false;
  return true;
}

/**
 * Single-host scope check for tools that name their target explicitly (Burp
 * Repeater/Intruder and the browser agent) instead of embedding it in a shell
 * string. Fail-open like checkScope: with no parsed allowlist there is nothing
 * to compare against.
 */
export function isHostInScope(host: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "").split(":")[0];
  if (!h) return false;
  if (LOCAL_HOSTS.has(h)) return true;
  const allow = new Set([...LOCAL_HOSTS, ...allowlist.map((entry) => entry.toLowerCase())]);
  return allow.has(h) || allowListCovers(allow, h);
}