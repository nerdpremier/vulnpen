import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolArguments, toolCallArguments } from "../src/utils/toolArguments";

test("a no-argument tool call becomes {} rather than an empty string", () => {
  // "" is what the collector used to produce for a call with no argument
  // chunks, and Mongoose reads it as a *missing* required value — which made
  // every later save of that session throw "Session validation failed".
  assert.equal(toolCallArguments(""), "{}");
  assert.equal(toolCallArguments("   "), "{}");
  assert.equal(toolCallArguments(undefined), "{}");
  assert.equal(toolCallArguments(null), "{}");
  // Real arguments pass through untouched, including an explicit empty object.
  assert.equal(toolCallArguments("{}"), "{}");
  assert.equal(toolCallArguments('{"command":"ls"}'), '{"command":"ls"}');
  // And the result is always parseable, which the empty string never was.
  assert.deepEqual(parseToolArguments(toolCallArguments("")).args, {});
});

test("parses valid tool argument objects without changing them", () => {
  const result = parseToolArguments('{"action":"add_key_discovery","data":{"value":"10.4.0.0/16"}}');
  assert.equal(result.repaired, false);
  assert.deepEqual(result.args, {
    action: "add_key_discovery",
    data: { value: "10.4.0.0/16" },
  });
});

test("repairs a truncated outer JSON object", () => {
  const result = parseToolArguments('{"action":"add_key_discovery","data":{"title":"NHA"}');
  assert.equal(result.repaired, true);
  assert.deepEqual(result.args, {
    action: "add_key_discovery",
    data: { title: "NHA" },
  });
});

test("repairs nested arrays and objects only when their closers are unambiguous", () => {
  const result = parseToolArguments('{"items":[{"name":"router"}]');
  assert.equal(result.repaired, true);
  assert.deepEqual(result.args, { items: [{ name: "router" }] });
});

test("rejects unterminated strings and trailing garbage", () => {
  assert.throws(
    () => parseToolArguments('{"cmd":"echo hello}'),
    /invalid JSON tool arguments/,
  );
  assert.throws(
    () => parseToolArguments('{"cmd":"echo hello"} unexpected'),
    /invalid JSON tool arguments/,
  );
});

test("rejects non-object JSON values", () => {
  assert.throws(() => parseToolArguments("[]"), /tool arguments must decode to a JSON object/);
  assert.throws(() => parseToolArguments("null"), /tool arguments must decode to a JSON object/);
});
