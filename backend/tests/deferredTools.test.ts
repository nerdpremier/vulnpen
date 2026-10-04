import { test } from "node:test";
import assert from "node:assert/strict";
import { toolRegistry } from "../src/tools/registry";
import { DEFERRED_TOOLS } from "../src/tools/deferred";

const schemas = (loaded?: string[]) =>
  toolRegistry
    .toOpenAISchemas({ agentRole: "main", loadedTools: loaded })
    .map((t) => t.function.name);

test("deferred tools are hidden from the default schema set", () => {
  const names = schemas();
  for (const deferred of DEFERRED_TOOLS) {
    assert.ok(!names.includes(deferred), `${deferred} should be deferred`);
  }
  // core tools stay
  assert.ok(names.includes("run_bash"));
  assert.ok(names.includes("wstg_test_plan"));
  assert.ok(names.includes("load_tools"));
});

test("load_tools pulls deferred tools back into the set", () => {
  const names = schemas(["send_to_burp_intruder", "map_finding_owasp"]);
  assert.ok(names.includes("send_to_burp_intruder"));
  assert.ok(names.includes("map_finding_owasp"));
  // other deferred tools stay hidden
  assert.ok(!names.includes("burp_collaborator"));
});

test("user-disabled tools stay disabled even when loaded", () => {
  const names = schemas(["send_to_burp_intruder"]);
  const disabled = toolRegistry
    .toOpenAISchemas({
      agentRole: "main",
      loadedTools: ["send_to_burp_intruder"],
      disabledTools: ["send_to_burp_intruder"],
    })
    .map((t) => t.function.name);
  assert.ok(!disabled.includes("send_to_burp_intruder"));
  void names;
});
