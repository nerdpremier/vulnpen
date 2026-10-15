import assert from "node:assert/strict";
import test from "node:test";
import { elideMiddle } from "../src/utils/transcript";

// Three handlers lean on this: tool output (agent.tools truncateOutput), Burp
// repeater responses and Burp proxy history entries. Head-only truncation lost
// whatever the target appended last — a reflected payload, a stack trace, a
// trailing JSON field — which is usually the part that proves the point.
test("elideMiddle keeps the opening and the tail, not the head alone", () => {
  const opening = "HTTP/1.1 200 OK\n\n";
  const tail = ',"flag":"FLAG{trailing}"';
  const text = opening + "a".repeat(20_000) + tail;

  const elided = elideMiddle(text, 8_000, "\n...\n", 0.4);

  assert.ok(elided.startsWith("HTTP/1.1 200 OK"), "opening survives");
  assert.ok(elided.includes('FLAG{trailing}'), "tail survives");
  assert.ok(elided.length < text.length, "something was elided");
});

test("text under the ceiling is returned unchanged", () => {
  const text = "GET /x HTTP/1.1\nHost: h\n";
  assert.equal(elideMiddle(text, 8_000, "\n...\n", 0.4), text);
});
