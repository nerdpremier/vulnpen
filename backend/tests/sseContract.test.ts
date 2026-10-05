import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ─── SSE cross-repo contract ────────────────────────────────────────────
// The event catalog in src/utils/sse-events.ts is typed, so a backend
// writer using an unknown event fails to compile — but the consumer lives
// in untyped frontend JS (useAgentStream.js, the single SSE listener; it
// also synthesizes its own close event). A renamed or added event would
// silently break the chat UI at runtime instead of failing to compile.
// This test parses both sources and holds the two sides together.

const catalogSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "utils", "sse-events.ts"),
  "utf-8",
);
const hookSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "frontend", "src", "hooks", "useAgentStream.js"),
  "utf-8",
);

// Keys of the SseEventMap interface: the region between its declaration and
// its closing brace, whose members are exactly the two-space-indented
// `name: ...` entries.
function parseCatalogEvents(source: string): string[] {
  const start = source.indexOf("export interface SseEventMap");
  assert.ok(start !== -1, "SseEventMap interface was found");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
}

function parseHookEvents(source: string): string[] {
  return [...source.matchAll(/onEvent\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
}

const catalogEvents = new Set(parseCatalogEvents(catalogSource));
const hookEvents = new Set(parseHookEvents(hookSource));

/** Emitted by the frontend's own stream wrapper (services/agent.service.js) when the response closes — not a backend event. */
const FRONTEND_SYNTHETIC_EVENTS = new Set(["_stream_end"]);

test("both sides of the SSE contract were parsed", () => {
  assert.ok(catalogEvents.size >= 20, "the catalog keys were parsed, got: " + [...catalogEvents].join(", "));
  assert.ok(hookEvents.size >= 20, "the hook registrations were parsed, got: " + [...hookEvents].join(", "));
});

test("every catalog event has a frontend consumer", () => {
  const unconsumed = [...catalogEvents].filter((e) => !hookEvents.has(e));
  assert.deepEqual(
    unconsumed,
    [],
    "catalog events the chat UI would silently drop — consume them in useAgentStream or drop them from the catalog",
  );
});

test("every event the hook consumes exists in the catalog", () => {
  const unknown = [...hookEvents].filter(
    (e) => !catalogEvents.has(e) && !FRONTEND_SYNTHETIC_EVENTS.has(e),
  );
  assert.deepEqual(
    unknown,
    [],
    "hook registrations with no backend emitter — add the event to SseEventMap or fix the name",
  );
});

test("frontend-synthetic events are not catalog members", () => {
  const leaked = [...FRONTEND_SYNTHETIC_EVENTS].filter((e) => catalogEvents.has(e));
  assert.deepEqual(
    leaked,
    [],
    "synthetic events belong to the frontend wrapper, not the backend catalog",
  );
});
