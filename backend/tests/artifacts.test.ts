import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vulnpen-artifacts-"));

import {
  filterKnownScreenshots,
  newScreenshotName,
  resolveSessionFile,
  saveSessionScreenshot,
} from "../src/services/artifacts.service";
import { getDataDir } from "../src/utils/loadConfig";

const dataDir = getDataDir();

beforeEach(() => {
  fs.rmSync(path.join(dataDir, "screenshots"), { recursive: true, force: true });
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("saveSessionScreenshot writes through the sanitized session directory", async () => {
  const written: string[] = [];
  const shot = await saveSessionScreenshot("session/with/slashes", "shot.png", (filePath) => {
    written.push(filePath);
    fs.writeFileSync(filePath, "png");
  });

  assert.ok(shot.ok);
  assert.equal(shot.fileName, "shot.png");
  // The session id is flattened into one safe directory name; the capture
  // happened exactly once, at the resolved path.
  assert.equal(written.length, 1);
  const expectedDir = path.join(dataDir, "screenshots", "session_with_slashes");
  assert.equal(path.dirname(written[0]), expectedDir);
  assert.ok(fs.existsSync(path.join(expectedDir, "shot.png")));
});

test("saveSessionScreenshot reports a failed capture instead of throwing", async () => {
  const shot = await saveSessionScreenshot("s", "shot.png", () => {
    throw new Error("browser closed");
  });
  assert.ok(!shot.ok);
  assert.match((shot as { error: Error }).error.message, /browser closed/);
});

test("filterKnownScreenshots keeps only names this session actually produced", () => {
  const dir = path.join(dataDir, "screenshots", "sess");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "real.png"), "png");

  const { kept, dropped } = filterKnownScreenshots("sess", ["real.png", "made-up.png"]);
  assert.deepEqual(kept, ["real.png"]);
  assert.deepEqual(dropped, ["made-up.png"]);
});

test("resolveSessionFile refuses traversal, unknown types and missing files", () => {
  fs.mkdirSync(path.join(dataDir, "screenshots", "sess"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "screenshots", "sess", "evidence.png"), "png");

  assert.deepEqual(resolveSessionFile("sess", "../../etc/passwd"), {
    ok: false,
    reason: "invalid-filename",
  });
  assert.deepEqual(resolveSessionFile("sess", "evidence.exe"), {
    ok: false,
    reason: "unsupported-type",
  });
  assert.deepEqual(resolveSessionFile("sess", "missing.png"), {
    ok: false,
    reason: "not-found",
  });

  const resolved = resolveSessionFile("sess", "evidence.png");
  assert.ok(resolved.ok);
  assert.equal((resolved as { mime: string }).mime, "image/png");
  assert.ok(fs.existsSync((resolved as { filePath: string }).filePath));
});

test("newScreenshotName is filesystem-safe and unique per call", () => {
  const a = newScreenshotName();
  const b = newScreenshotName();
  assert.match(a, /\.png$/);
  assert.ok(!/[:.]/.test(a.replace(/\.png$/, "")));
  assert.notEqual(a, b);
});

test("every tool that can be unavailable declares its readiness on its own definition", async () => {
  const { toolRegistry } = await import("../src/tools/registry");
  const { getUnconfiguredToolNames } = await import("../src/utils/toolAvailability");

  // With no .env data dir of its own, Burp and the browser agent are both
  // unconfigured; the registry is the single source of truth for which.
  const unconfigured = new Set(await getUnconfiguredToolNames());
  for (const name of ["send_to_burp_repeater", "search_burp_proxy_history", "browser_action"]) {
    assert.ok(unconfigured.has(name), `${name} should be reported unconfigured`);
  }
  assert.ok(!unconfigured.has("run_bash"), "run_bash has no external dependency");

  // The readiness gate lives on the definition and the run path reuses it:
  // an unconfigured tool refuses before execute, with the same text the
  // schema filter used to drop it.
  const browser = toolRegistry.get("browser_action")!;
  assert.ok(browser.checkReady, "browser_action declares checkReady");
  const refusal = await browser.checkReady!();
  assert.match(refusal ?? "", /not enabled|model/i);
});
