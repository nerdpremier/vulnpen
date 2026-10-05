import fs from "fs";
import path from "path";
import { getDataDir } from "../utils/loadConfig";

/**
 * The one place that knows where agent-produced artifacts (browser
 * screenshots) live and how their names are kept safe: session ids are
 * sanitized into directory names, filenames carry no path components, and the
 * servable MIME set is fixed. Handlers save through saveSessionScreenshot,
 * the evidence validator filters through filterKnownScreenshots, and the file
 * endpoint resolves through resolveSessionFile — none of them touch the
 * on-disk layout themselves.
 */

const SESSION_FILE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
};

function screenshotDir(sessionId: string | undefined): string {
  const safeSession = (sessionId || "session").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getDataDir(), "screenshots", safeSession);
}

/** Collision-free filename for one capture: timestamp plus a random suffix,
 *  since two calls inside the same millisecond would otherwise overwrite. */
export function newScreenshotName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}.png`;
}

export type SavedScreenshot =
  | { ok: true; fileName: string }
  | { ok: false; error: unknown };

/**
 * Persist one screenshot: creates the session's directory and hands the full
 * target path to `capture` (which performs the actual write, e.g. a Playwright
 * page.screenshot). A failed capture is reported, never thrown — a missing
 * screenshot must not fail the tool call that produced it.
 */
export async function saveSessionScreenshot(
  sessionId: string | undefined,
  fileName: string,
  capture: (filePath: string) => Promise<unknown> | unknown,
): Promise<SavedScreenshot> {
  try {
    const dir = screenshotDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    await capture(path.join(dir, fileName));
    return { ok: true, fileName };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Screenshot evidence must point at captures this session actually produced —
 * a made-up filename would render as a broken image. Splits the claimed names
 * into ones that exist on disk and ones to report back as dropped.
 */
export function filterKnownScreenshots(
  sessionId: string | undefined,
  names: string[],
): { kept: string[]; dropped: string[] } {
  const dir = screenshotDir(sessionId);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of names) {
    (fs.existsSync(path.join(dir, name)) ? kept : dropped).push(name);
  }
  return { kept, dropped };
}

export type ResolvedSessionFile =
  | { ok: true; filePath: string; mime: string }
  | { ok: false; reason: "invalid-filename" | "unsupported-type" | "not-found" };

/**
 * Resolve a stored artifact filename to a servable file. Names carry no path
 * components, so traversal is impossible by construction; the reason travels
 * back so the endpoint can pick the right status code.
 */
export function resolveSessionFile(sessionId: string, filename: string): ResolvedSessionFile {
  if (!filename || /[/]|\.\./.test(filename)) {
    return { ok: false, reason: "invalid-filename" };
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = SESSION_FILE_MIME[ext];
  if (!mime) return { ok: false, reason: "unsupported-type" };
  const filePath = path.join(screenshotDir(sessionId), filename);
  if (!fs.existsSync(filePath)) return { ok: false, reason: "not-found" };
  return { ok: true, filePath, mime };
}
