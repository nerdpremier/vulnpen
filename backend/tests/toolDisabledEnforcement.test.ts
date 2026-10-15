import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "../src/tools/types";
import { executeToolCall, executeConsentedTool } from "../src/services/agent.tools";
import { buildCapabilityPromptContext } from "../src/capabilities/registry";

const ctx = { sessionId: "session-1" } as unknown as ExecutionContext;

const callbacks = () => {
  const errors: string[] = [];
  return {
    errors,
    api: {
      onToolStart: () => {},
      onToolOutput: () => {},
      onToolDone: () => {},
      onToolError: (_id: string, error: string) => errors.push(error),
      onConsentRequired: () => {},
    } as unknown as Parameters<typeof executeToolCall>[2],
  };
};

test("a disabled tool does not run, even when the name still arrives", async () => {
  // The schema already drops it, but a stale prompt description or a setting
  // changed after parking can still produce the name. Disabling a tool is an
  // operator decision, so it is enforced where the call would run.
  const { errors, api } = callbacks();
  const result = await executeToolCall(
    "session-1",
    { id: "call-1", name: "run_bash", arguments: JSON.stringify({ command: "id" }) },
    api,
    ctx,
    false,
    "auto",
    ["run_bash"],
  );

  assert.equal(result.kind, "executed");
  assert.equal(result.kind === "executed" && result.result.exitCode, 1);
  assert.match(result.kind === "executed" ? result.result.output : "", /disabled in settings/);
  assert.match(errors.join("\n"), /disabled in settings/);
});

test("a consented tool is refused when disabled after it was parked", async () => {
  const { errors, api } = callbacks();
  const result = await executeConsentedTool(
    "session-1",
    "call-2",
    "run_bash",
    { command: "id" },
    api,
    ctx,
    undefined,
    ["run_bash"],
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /disabled in settings/);
  assert.match(errors.join("\n"), /disabled in settings/);
});

test("an enabled tool still runs", async () => {
  const { api } = callbacks();
  const result = await executeToolCall(
    "session-1",
    { id: "call-3", name: "list_shells", arguments: "{}" },
    api,
    ctx,
    false,
    "auto",
    [],
  );
  assert.equal(result.kind, "executed");
  assert.doesNotMatch(
    result.kind === "executed" ? result.result.output : "",
    /disabled in settings/,
  );
});

test("the capability block names the installed tools", () => {
  // The bucket ids on capabilities must resolve in capabilityBuckets, or the
  // prompt builder skips every one and the model is told nothing about what
  // the box can do.
  const rendered = buildCapabilityPromptContext(["python3", "nmap", "sqlmap"]);
  assert.notEqual(rendered.trim(), "");
  assert.match(rendered, /python3/);
  assert.match(rendered, /nmap/);
  assert.match(rendered, /sqlmap/);
});
