import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecutionContext,
  SafetyDetail,
  ToolDefinition,
} from "../src/tools/types";
import {
  ApprovalRejectionTracker,
  decideToolConsent,
  effectiveSafetyDetail,
} from "../src/services/tool-approval.service";
import { executeToolCall } from "../src/services/agent.tools";
import { buildPendingConsentBatch } from "../src/services/consent-batch";

const tool: ToolDefinition = {
  name: "run_bash",
  description: "Run a command",
  parameters: { type: "object" },
  async execute() {
    return { output: "ok", exitCode: 0 };
  },
};

const context = { sessionId: "session-1" } as ExecutionContext;

test("auto mode runs an action the boundary did not flag", () => {
  const result = decideToolConsent({ mode: "auto", safetyTriggered: false });
  assert.equal(result.requireConsent, false);
  assert.equal(result.source, "mode");
});

test("requires consent mode asks for every action", () => {
  const result = decideToolConsent({ mode: "requires_consent", safetyTriggered: false });
  assert.equal(result.requireConsent, true);
  assert.equal(result.source, "mode");
});

test("a boundary-crossing action asks in auto mode too", () => {
  const result = decideToolConsent({ mode: "auto", safetyTriggered: true });
  assert.equal(result.requireConsent, true);
  assert.equal(result.source, "safety");
});

test("no mode turns a destructive target action into a question", () => {
  // The refusal is not a mode outcome. In neither mode does a destructive
  // target action become something a person — or, before this mode set was
  // reduced, a reviewer model — could answer "yes" to.
  const destructive: SafetyDetail = {
    kind: "destructive_target",
    reason: "คำสั่งนี้จะลบข้อมูลบนเป้าหมาย",
    impact: "ข้อมูลสูญหาย",
  };
  for (const mode of ["auto", "requires_consent"] as const) {
    for (const safetyTriggered of [true, false]) {
      const result = decideToolConsent({ mode, safetyTriggered, safetyDetail: destructive });
      assert.equal(result.requireConsent, false, `mode ${mode}`);
      assert.equal(result.denied, true, `mode ${mode}`);
      assert.equal(result.source, "boundary", `mode ${mode}`);
    }
  }
});

test("three consecutive denials interrupt but an approval resets the streak", () => {
  const tracker = new ApprovalRejectionTracker();
  assert.equal(tracker.record(true), false);
  assert.equal(tracker.record(true), false);
  assert.equal(tracker.record(false), false);
  assert.equal(tracker.record(true), false);
  assert.equal(tracker.record(true), false);
  assert.equal(tracker.record(true), true);
});

test("ten denials in the last fifty reviews interrupt and old denials roll out", () => {
  const tracker = new ApprovalRejectionTracker();
  for (let index = 0; index < 9; index++) {
    assert.equal(tracker.record(true), false);
    tracker.record(false);
  }
  assert.equal(tracker.record(true), true);

  const rolling = new ApprovalRejectionTracker();
  for (let index = 0; index < 9; index++) {
    rolling.record(true);
    rolling.record(false);
  }
  for (let index = 0; index < 41; index++) rolling.record(false);
  assert.equal(rolling.record(true), false);
});

test("consent batches retain every action, reason, arguments, and safety flag", () => {
  const batch = buildPendingConsentBatch(
    [
      {
        kind: "consent_required",
        toolCallId: "one",
        toolName: "run_bash",
        approvalReason: "Writes outside the workspace.",
        safetyBlock: false,
      },
      {
        kind: "consent_required",
        toolCallId: "two",
        toolName: "write_to_shell",
        approvalReason: "Potentially destructive command.",
        safetyBlock: true,
      },
    ],
    [
      { id: "one", name: "run_bash", arguments: '{"command":"touch /tmp/a"}' },
      {
        id: "two",
        name: "write_to_shell",
        arguments: '{"shell_id":"s1","input":"rm -rf /"}',
      },
    ],
  );
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0].arguments, { command: "touch /tmp/a" });
  assert.equal(batch[0].approvalReason, "Writes outside the workspace.");
  assert.equal(batch[1].safetyBlock, true);
  assert.match(batch[1].approvalReason ?? "", /destructive/);
});

test("a destructive target action is refused in every mode, with no approval path", async () => {
  const destructive: SafetyDetail = {
    kind: "destructive_target",
    reason: "ส่งคำขอ HTTP ด้วยเมธอด DELETE ไปยังเป้าหมาย",
    impact: "ข้อมูลบนเป้าหมายถูกลบถาวร",
  };
  const modes = ["auto", "requires_consent"] as const;
  for (const mode of modes) {
    const result = await decideToolConsent({
      mode,
      tool,
      args: { command: "curl -s -X DELETE http://juice-shop:3000/api/Users/7" },
      context,
      safetyTriggered: true,
      safetyDetail: destructive,
      // Worst case on purpose: the reviewer model is mistaken, drifted or
      // prompt-injected through the (untrusted) tool arguments and answers
      // safe. A probabilistic verdict must never be able to unlock something
      // irreversible, so the deterministic boundary has to refuse anyway.
      evaluator: async () => ({ safe: true, reason: "must be ignored" }),
    });
    assert.equal(result.denied, true, `mode ${mode}`);
    assert.equal(result.requireConsent, false, `mode ${mode}`);
    assert.equal(result.source, "boundary", `mode ${mode}`);
  }
});

test("a destructive command is blocked end to end without ever asking for consent", async () => {
  const errors: string[] = [];
  const consents: string[] = [];
  const callbacks = {
    onToolStart: () => {},
    onToolOutput: () => {},
    onToolDone: () => {},
    onToolError: (_id: string, error: string) => errors.push(error),
    onConsentRequired: (id: string) => consents.push(id),
  };
  const result = await executeToolCall(
    "session-1",
    {
      id: "call-1",
      name: "run_bash",
      arguments: JSON.stringify({ command: "curl -s -X DELETE http://juice-shop:3000/api/Users/7" }),
    },
    (callbacks as unknown) as Parameters<typeof executeToolCall>[2],
    ({ sessionId: "session-1" } as unknown) as ExecutionContext,
    false,
    "auto",
  );
  assert.equal(result.kind, "boundary_blocked");
  assert.equal(result.safetyKind, "destructive_target");
  assert.equal(consents.length, 0);
  assert.match(errors.join("\n"), /proof-of-concept boundary/);
});

test("the safety-protection setting silences prompts, never the absolute refusal", () => {
  const destructive: SafetyDetail = { kind: "destructive_target", reason: "r", impact: "i" };
  const box: SafetyDetail = { kind: "dangerous", reason: "r", impact: "i" };
  const scope: SafetyDetail = { kind: "out_of_scope", reason: "r", impact: "i" };

  // The setting is the operator asking for fewer prompts. It is not the operator
  // suspending the one promise the product makes absolutely, so a
  // destructive-target verdict survives it and the noisy ones do not.
  assert.equal(effectiveSafetyDetail(destructive, true)?.kind, "destructive_target");
  assert.equal(effectiveSafetyDetail(box, true), undefined);
  assert.equal(effectiveSafetyDetail(scope, true), undefined);

  // Off by default: every verdict reaches the gate untouched.
  assert.equal(effectiveSafetyDetail(destructive, false)?.kind, "destructive_target");
  assert.equal(effectiveSafetyDetail(box, false)?.kind, "dangerous");
  assert.equal(effectiveSafetyDetail(scope, false)?.kind, "out_of_scope");
  assert.equal(effectiveSafetyDetail(undefined, false), undefined);
  assert.equal(effectiveSafetyDetail(undefined, true), undefined);
});

test("a target DELETE is still refused end to end with safety protections disabled", async () => {
  const errors: string[] = [];
  const consents: string[] = [];
  const callbacks = {
    onToolStart: () => {},
    onToolOutput: () => {},
    onToolDone: () => {},
    onToolError: (_id: string, error: string) => errors.push(error),
    onConsentRequired: (id: string) => consents.push(id),
  };
  const result = await executeToolCall(
    "session-1",
    {
      id: "call-2",
      name: "run_bash",
      arguments: JSON.stringify({ command: "curl -s -X DELETE http://juice-shop:3000/api/Users/7" }),
    },
    (callbacks as unknown) as Parameters<typeof executeToolCall>[2],
    ({ sessionId: "session-1" } as unknown) as ExecutionContext,
    true,
    "auto",
  );
  assert.equal(result.kind, "boundary_blocked");
  assert.equal(result.safetyKind, "destructive_target");
  assert.equal(consents.length, 0);
});
