import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The Browser Agent must not depend on a vision model.
 *
 * Magnitude's own agent loop (`agent.act(goal)`) locates every click target as a
 * coordinate through a small vision model, which is why VulnPen drives the page
 * through the DOM instead - see services/dom-browser.service.ts. That decision
 * only holds while nothing calls back into the loop: a single call reintroduces a
 * vision dependency, a screenshot per step, and a screen-space guess in place of
 * a locator. So the source tree itself is the assertion.
 *
 * The guard reads source text rather than compiled output, so it fails the moment
 * such a call is written, not later when a live run misbehaves.
 */
const SCANNED_DIRS = ["src", "scripts"];

/**
 * Strip line and block comments, so the prose explaining the rule is not mistaken
 * for the rule. Deliberately crude: this guards a codebase that does not hide
 * calls inside strings, and a false negative here is caught by the live check.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ROOT = path.join(__dirname, "..");

test("no source file drives Magnitude's vision loop", () => {
  const offenders: string[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (/\bagent\s*\.\s*act\s*\(/.test(code) || /moondream/i.test(code)) {
        offenders.push(path.relative(ROOT, file).replace(/\\/g, "/"));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These files call Magnitude's vision-driven loop, which reintroduces a " +
      "vision model and a screenshot per step. Drive the page with " +
      "snapshotPage / runDomAction instead:\n  " +
      offenders.join("\n  "),
  );
});

test("the guard actually walks the tree", () => {
  // A guard that silently inspects nothing passes forever.
  const files = sourceFiles(path.join(ROOT, "src"));
  assert.ok(
    files.length > 50,
    `expected to find the source tree, found ${files.length} files`,
  );
});
