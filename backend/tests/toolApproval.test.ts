import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext, SafetyDetail } from "../src/tools/types";
import { decideToolConsent, effectiveSafetyDetail } from "../src/services/tool-approval.service";
import { executeToolCall } from "../src/services/agent.tools";
import { buildPendingConsentBatch } from "../src/services/consent-batch";

test("auto mode runs an action the boundary did not flag", () => {
  const result = decideToolConsent({ mode: "auto", safetyTriggered: false });
  assert.equal(result.requireConsent, false);
  assert.equal(result.source, "mode");
});

test("manual mode asks for every action", () => {
  const result = decideToolConsent({ mode: "requires_consent", safetyTriggered: false });
  assert.equal(result.requireConsent, true);
  assert.equal(result.source, "mode");
});

test("a boundary-crossing action asks in auto mode too", () => {
  const result = decideToolConsent({ mode: "auto", safetyTriggered: true });
  assert.equal(result.requireConsent, true);
  assert.equal(result.source, "safety");
});

test("the human-facing modes turn a destructive target action into a question", () => {
  // Auto and Manual keep the operator in the loop for an irreversible action.
  // Bypass permissions is the fully autonomous exception.
  const destructive: SafetyDetail = {
    kind: "destructive_target",
    reason: "คำสั่งนี้จะลบข้อมูลบนเป้าหมาย",
    impact: "ข้อมูลสูญหาย",
  };
  for (const mode of ["auto", "requires_consent"] as const) {
    for (const safetyTriggered of [true, false]) {
      const result = decideToolConsent({ mode, safetyTriggered, safetyDetail: destructive });
      assert.equal(result.requireConsent, true, `mode ${mode}`);
      assert.equal(result.source, "boundary", `mode ${mode}`);
    }
  }
});

test("bypass permissions runs every action without asking", () => {
  const verdicts: Array<SafetyDetail | undefined> = [
    undefined,
    { kind: "dangerous", reason: "r", impact: "i" },
    { kind: "out_of_scope", reason: "r", impact: "i" },
    { kind: "destructive_target", reason: "r", impact: "i" },
  ];
  for (const safetyDetail of verdicts) {
    const result = decideToolConsent({
      mode: "auto_approve",
      safetyTriggered: safetyDetail !== undefined,
      safetyDetail,
    });
    assert.equal(result.requireConsent, false, `kind ${safetyDetail?.kind ?? "none"}`);
    assert.equal(result.source, "mode");
  }
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

test("a destructive command parks for operator approval in auto mode", async () => {
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
  assert.equal(result.kind, "consent_required");
  assert.equal(result.safetyKind, "destructive_target");
  assert.equal(consents.length, 1, "boundary should now park for approval");
  // pocBoundaryOutput was called inside executeToolCall, surfaced as onToolError.
  assert.match(errors.join("\n"), /Stopped at the proof-of-concept boundary/);
});

test("bypass permissions runs the destructive command instead of parking", async () => {
  const consents: string[] = [];
  const callbacks = {
    onToolStart: () => {},
    onToolOutput: () => {},
    onToolDone: () => {},
    onToolError: () => {},
    onConsentRequired: (id: string) => consents.push(id),
  };
  const result = await executeToolCall(
    "session-1",
    {
      id: "call-auto-approve",
      name: "run_bash",
      arguments: JSON.stringify({ command: "curl -s -X DELETE http://juice-shop:3000/api/Users/7" }),
    },
    (callbacks as unknown) as Parameters<typeof executeToolCall>[2],
    ({ sessionId: "session-1" } as unknown) as ExecutionContext,
    false,
    "auto_approve",
  );
  // The destructive verdict is still computed, but it never becomes a prompt:
  // the call reaches the tool and the operator is not asked.
  assert.equal(result.kind, "executed");
  assert.equal(consents.length, 0, "bypass permissions never parks for consent");
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

test("a target DELETE still parks for the operator with safety protections disabled", async () => {
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
  assert.equal(result.kind, "consent_required");
  assert.equal(result.safetyKind, "destructive_target");
  assert.equal(consents.length, 1);
});
