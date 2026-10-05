import { test } from "node:test";
import assert from "node:assert/strict";
import { toolRegistry } from "../src/tools/registry";
import { DEFERRED_TOOLS } from "../src/tools/deferred";
import {
  BROWSER_TOOL_NAMES,
  BURP_TOOL_NAMES,
  DEFERRED_TOOL_NAMES,
  REPORTING_TOOL_NAMES,
  SHELL_TOOL_NAMES,
} from "../src/tools/names";

test("every name group refers to a registered tool", () => {
  const registered = new Set(toolRegistry.getToolNames());
  for (const group of [SHELL_TOOL_NAMES, BURP_TOOL_NAMES, BROWSER_TOOL_NAMES, REPORTING_TOOL_NAMES]) {
    for (const name of group) {
      assert.ok(registered.has(name), `${name} is listed in tools/names.ts but not registered`);
    }
  }
});

test("the deferred set is exactly the deferred group, and all of them are registered", () => {
  const registered = new Set(toolRegistry.getToolNames());
  assert.deepEqual([...DEFERRED_TOOLS].sort(), [...DEFERRED_TOOL_NAMES].sort());
  for (const name of DEFERRED_TOOL_NAMES) {
    assert.ok(registered.has(name), `deferred tool ${name} is not registered`);
  }
});

test("name groups do not overlap", () => {
  const all = [...SHELL_TOOL_NAMES, ...BURP_TOOL_NAMES, ...BROWSER_TOOL_NAMES, ...REPORTING_TOOL_NAMES];
  assert.equal(new Set(all).size, all.length);
});
