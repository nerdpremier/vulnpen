/**
 * Minimal WOPI host for Collabora Online (LibreOffice in the browser).
 *
 * The frontend asks for an editor URL; we mint a short-lived WOPI access
 * token, look up Collabora's discovery document for the .docx edit action and
 * return the iframe URL. Collabora then calls back the CheckFileInfo /
 * GetFile / PutFile endpoints below — server-to-server, so those are
 * authorised by the token, not by the app session cookie.
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

export function collaboraUrl(): string {
  return (process.env.COLLABORA_URL || "http://localhost:9980").replace(/\/$/, "");
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Ask Collabora's discovery document for the .docx edit action URL. */
export async function getDocxEditUrlSrc(): Promise<string> {
  const res = await fetch(`${collaboraUrl()}/hosting/discovery`);
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
  const urlSrc = await getDocxEditUrlSrc();
  const wopiSrc = encodeURIComponent(`${wopiPublicBase()}/${sessionId}`);
  const separator = urlSrc.includes("?") ? "" : "?";
  const url =
    `${urlSrc}${separator}WOPISrc=${wopiSrc}&access_token=${token}&access_token_ttl=${Date.now() + TOKEN_TTL_MS}&lang=th`;
  return { url, token, tokenTtl: Date.now() + TOKEN_TTL_MS };
}
