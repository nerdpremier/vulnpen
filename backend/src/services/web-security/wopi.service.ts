/**
 * Minimal WOPI host for Collabora Online (LibreOffice in the browser).
 *
 * The frontend asks for an editor URL; we mint a short-lived WOPI access
 * token, look up Collabora's discovery document for the .docx edit action and
 * return the iframe URL. Collabora then calls back the CheckFileInfo /
 * GetFile / PutFile endpoints below — server-to-server, so those are
 * authorised by the token, not by the app session cookie.
 *
 * Two different networks are in play, so two different base URLs are needed:
 * COLLABORA_URL is how *this process* reaches Collabora's discovery document
 * (inside Docker that is the `collabora` service name; on a host-run backend
 * it is localhost). COLLABORA_PUBLIC_URL is how *the browser* reaches the
 * editor iframe (host-localhost). Confusing the two is exactly what made the
 * report page return HTTP 500 with ECONNREFUSED.
 */
import crypto from "crypto";

const TOKEN_TTL_MS = 60 * 60 * 1000;

const wopiTokens = new Map<string, { sessionId: string; uid: string; expiresAt: number }>();

export function createWopiToken(sessionId: string, uid: string): string {
  const token = crypto.randomBytes(24).toString("hex");
  wopiTokens.set(token, { sessionId, uid, expiresAt: Date.now() + TOKEN_TTL_MS });
  // opportunistic cleanup of expired entries
  for (const [key, entry] of wopiTokens) {
    if (entry.expiresAt < Date.now()) wopiTokens.delete(key);
  }
  return token;
}

export function resolveWopiToken(token: string): { sessionId: string; uid: string } | null {
  const entry = wopiTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    wopiTokens.delete(token);
    return null;
  }
  return { sessionId: entry.sessionId, uid: entry.uid };
}

export function wopiPublicBase(): string {
  return (process.env.WOPI_PUBLIC_BASE || "http://host.docker.internal:8080/api/wopi/files").replace(/\/$/, "");
}

/** Server-side address of Collabora: the compose service name inside Docker. */
export function collaboraUrl(): string {
  if (process.env.COLLABORA_URL) return process.env.COLLABORA_URL.replace(/\/$/, "");
  if (process.env.VULNPEN_DOCKER === "1") return "http://collabora:9980";
  return "http://localhost:9980";
}

/** Browser-side address of Collabora: what the editor iframe runs under. */
export function collaboraPublicUrl(): string {
  return (process.env.COLLABORA_PUBLIC_URL || "http://localhost:9980").replace(/\/$/, "");
}

/** Rewrite a Collabora URL from the server-side host to the browser-side one
 *  (same scheme/path; only the authority may differ). */
export function publicCollaboraUrl(internalUrl: string): string {
  try {
    const internal = new URL(collaboraUrl());
    const pub = new URL(collaboraPublicUrl());
    const parsed = new URL(internalUrl);
    if (parsed.host === internal.host) {
      parsed.protocol = pub.protocol;
      parsed.host = pub.host;
      return parsed.toString().replace(/\?$/, "");
    }
  } catch {
    // fall through and return the discovery URL unchanged
  }
  return internalUrl;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Ask Collabora's discovery document for the .docx edit action URL. */
export async function getDocxEditUrlSrc(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${collaboraUrl()}/hosting/discovery`);
  } catch (err: unknown) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const detail = code ? ` (${code})` : "";
    throw new Error(
      `Collabora is unreachable at ${collaboraUrl()}/hosting/discovery${detail} — ` +
      `check the Collabora container is up (docker ps) and COLLABORA_URL points at it`,
    );
  }
  if (!res.ok) throw new Error(`Collabora discovery failed with HTTP ${res.status}`);
  const xml = await res.text();
  const appBlock = xml.match(new RegExp(`<app name="${DOCX_MIME}"[^>]*>([\\s\\S]*?)</app>`));
  const action = appBlock?.[1]?.match(/<action\s[^>]*name="edit"[^>]*urlsrc="([^"]+)"/);
  if (!action) throw new Error("Collabora discovery does not advertise a docx edit action");
  return action[1];
}

/** Full iframe URL for editing the session's report in Collabora. */
export async function buildWordEditorUrl(sessionId: string, uid: string): Promise<{ url: string; token: string; tokenTtl: number }> {
  const token = createWopiToken(sessionId, uid);
  // Discovery runs over the server-side address, but the iframe must load
  // over the browser-side address — Collabora advertises its own hostname.
  const urlSrc = publicCollaboraUrl(await getDocxEditUrlSrc());
  const wopiSrc = encodeURIComponent(`${wopiPublicBase()}/${sessionId}`);
  const separator = urlSrc.includes("?") ? "" : "?";
  // The report is a formal Thai document on white paper: pin the light UI and
  // a white canvas. Collabora otherwise follows the browser's
  // prefers-color-scheme, which turned the editor — chrome and page — dark.
  const url =
    `${urlSrc}${separator}WOPISrc=${wopiSrc}&access_token=${token}&access_token_ttl=${Date.now() + TOKEN_TTL_MS}&lang=th&ui_theme=light&background=ffffff`;
  return { url, token, tokenTtl: Date.now() + TOKEN_TTL_MS };
}
