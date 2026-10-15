#!/usr/bin/env node
/**
 * Remove compiled output from dist/ whose source no longer exists.
 *
 * `tsc` never deletes the output of a source file that was removed, so a
 * deleted module keeps sitting in dist/ — and dist/ is what `node dist/server.js`
 * runs. Measured on this repo before this script existed: 60 such files, left
 * behind by successive refactors (caido/ctf/mcp/mythic/swarm handlers and their
 * routes, and the egress proxy modules before them).
 *
 * A full `rm -rf dist` fixes the same thing but throws away every unchanged
 * file, discards tsc's incremental state, and trips bulk-delete guards in
 * sandboxed environments. This unlinks only files that provably have no source,
 * and names them, so a stale build is visible instead of silent.
 *
 * Run before tsc (see the `build` script), or on its own to inspect.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

// tsc emits `src/a/b.ts` as `dist/a/b.js` (plus `.js.map` / `.d.ts` / `.d.ts.map`
// when those options are on). Any dist file whose stem has no source with one of
// these extensions is stale.
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".json"];
const EMITTED_SUFFIX = /\.(js|js\.map|d\.ts|d\.ts\.map)$/;

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function walkDirsDeepestFirst(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    walkDirsDeepestFirst(full, out);
    out.push(full);
  }
  return out;
}

if (!fs.existsSync(distDir)) process.exit(0);

const stale = walkFiles(distDir).filter((file) => {
  const stem = path.relative(distDir, file).replace(EMITTED_SUFFIX, "");
  return !SOURCE_EXTS.some((ext) => fs.existsSync(path.join(srcDir, stem + ext)));
});

for (const file of stale) fs.unlinkSync(file);

// Drop the directories the removals emptied, deepest first.
for (const dir of walkDirsDeepestFirst(distDir)) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty — a live module still lives there.
  }
}

if (stale.length > 0) {
  console.log(`clean-dist: removed ${stale.length} stale file(s) from dist/`);
  for (const file of stale) console.log(`  ${path.relative(root, file).replace(/\\/g, "/")}`);
} else {
  console.log("clean-dist: dist/ already matches src/");
}
