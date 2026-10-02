import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecutionContext,
  SafetyDetail,
  ToolDefinition,
} from "../src/tools/types";
import {
  ApprovalRejectionTracker,
  compactApprovalTranscript,
  decideToolConsent,
  parseToolSafetyAssessment,
} from "../src/services/tool-approval.service";
import {
  buildPendingConsentBatch,
  executeToolCall,
} from "../src/services/agent.tools";

const tool: ToolDefinition = {
  name: "run_bash",
  description: "Run a command",
  parameters: { type: "object" },
  requiresConsent: true,
  async execute() {
    return { output: "ok", exitCode: 0 };
  },
};

const context = { sessionId: "session-1" } as ExecutionContext;

test("auto mode preserves automatic execution for consent-marked tools", async () => {
  const result = await decideToolConsent({
    mode: "auto",
    tool,
    args: { command: "pwd" },
    context,
    safetyTriggered: false,
  });
  assert.equal(result.requireConsent, false);
});

test("requires consent mode asks for every action", async () => {
  const result = await decideToolConsent({
    mode: "requires_consent",
    tool,
    args: {},
    context,
    safetyTriggered: false,
  });
  assert.equal(result.requireConsent, true);
  assert.equal(result.source, "mode");
});

test("built-in safety block still requires review in automatic mode", async () => {
  let called = false;
  const result = await decideToolConsent({
    mode: "auto",
    tool,
    args: { command: "rm -rf /" },
    context,
    safetyTriggered: true,
    evaluator: async () => {
      called = true;
      return { safe: true, reason: "incorrect" };
    },
  });
  assert.equal(result.requireConsent, true);
  assert.equal(result.source, "safety");
  assert.equal(called, false);
});

test("Safety-triggered tools are blocked outside explicit safe verdicts", async () => {
  // Subagents refuse (requireConsent signals the caller to block); the main
  // agent surfaces a consent prompt. Either way, no silent execution.
  const modes = ["auto", "auto_approve", "requires_consent"] as const;
  for (const mode of modes) {
    const result = await decideToolConsent({
      mode,
      tool,
      args: { command: "rm -rf /" },
      context,
      safetyTriggered: true,
    });
    assert.equal(result.requireConsent, true, `mode ${mode}`);
  }

  // auto_approve only bypasses the block on an explicit safe verdict.
  const approved = await decideToolConsent({
    mode: "auto_approve",
    tool,
    args: { command: "rm -rf /tmp/own-file" },
    context,
    safetyTriggered: true,
    evaluator: async () => ({ safe: true, reason: "Bounded to workspace file." }),
  });
  assert.equal(approved.requireConsent, false);
  assert.equal(approved.reviewed, true);

  // And even the reviewer never runs when safety is not triggered.
  const unflagged = await decideToolConsent({
    mode: "auto",
    tool,
    args: { command: "pwd" },
    context,
    safetyTriggered: false,
  });
  assert.equal(unflagged.requireConsent, false);
});

test("auto approve runs only an explicitly safe AI verdict", async () => {
  const safe = await decideToolConsent({
    mode: "auto_approve",
    tool,
    args: { command: "pwd" },
    context,
    safetyTriggered: false,
    evaluator: async () => ({
      safe: true,
      reason: "Read-only workspace inspection.",
    }),
  });
  const unsafe = await decideToolConsent({
    mode: "auto_approve",
    tool,
    args: { command: "sudo reboot" },
    context,
    safetyTriggered: false,
    evaluator: async () => ({
      safe: false,
      reason: "Disruptive system action.",
    }),
  });
  assert.equal(safe.requireConsent, false);
  assert.equal(safe.reviewed, true);
  assert.equal(unsafe.requireConsent, false);
  assert.equal(unsafe.denied, true);
  assert.match(unsafe.reason, /Disruptive/);
});

test("approve for me does not review routine actions", async () => {
  let called = false;
  const routineTool = { ...tool, requiresConsent: false };
  const result = await decideToolConsent({
    mode: "auto_approve",
    tool: routineTool,
    args: { command: "pwd" },
    context,
    safetyTriggered: false,
    evaluator: async () => {
      called = true;
      return { safe: false, reason: "should not run" };
    },
  });

  assert.equal(result.requireConsent, false);
  assert.equal(result.reviewed, false);
  assert.equal(called, false);
});

test("auto approve fails closed when review is unavailable or throws", async () => {
  const unavailable = await decideToolConsent({
    mode: "auto_approve",
    tool,
    args: {},
    context,
    safetyTriggered: false,
  });
  const failed = await decideToolConsent({
    mode: "auto_approve",
    tool,
    args: {},
    context,
    safetyTriggered: false,
    evaluator: async () => {
      throw new Error("provider offline");
    },
  });
  assert.equal(unavailable.requireConsent, true);
  assert.equal(unavailable.source, "fallback");
  assert.equal(failed.requireConsent, true);
  assert.match(failed.reason, /provider offline/);
});

test("AI response parser accepts strict boolean JSON and rejects ambiguity", () => {
  assert.deepEqual(
    parseToolSafetyAssessment('{"safe":true,"reason":"Read only"}'),
    { safe: true, reason: "Read only" },
  );
  assert.throws(
    () => parseToolSafetyAssessment('{"safe":"true","reason":"maybe"}'),
    /boolean safe verdict/,
  );
  assert.throws(() => parseToolSafetyAssessment("probably safe"), /not JSON/);
});

test("approval transcript is compact and excludes system instructions", () => {
  const messages = [
    { role: "system", content: "secret system prompt" },
    ...Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `${index}: ${"x".repeat(1_100)}`,
    })),
  ];
  const transcript = compactApprovalTranscript(messages);

  assert.equal(transcript.length, 12);
  assert.equal(transcript[0].content.startsWith("1:"), true);
  assert.equal(
    transcript.every((message) => message.content.length <= 1_000),
    true,
  );
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
        toolCallId: "one",
        toolName: "run_bash",
        result: { output: "", exitCode: 0 },
        needsConsent: true,
        approvalReason: "Writes outside the workspace.",
        safetyBlock: false,
      },
      {
        toolCallId: "two",
        toolName: "write_to_shell",
        result: { output: "", exitCode: 0 },
        needsConsent: true,
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
  const modes = ["auto", "auto_approve", "requires_consent"] as const;
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
  assert.equal(result.needsConsent, false);
  assert.equal(result.approvalDenied, true);
  assert.equal(result.safetyKind, "destructive_target");
  assert.equal(consents.length, 0);
  assert.match(errors.join("\n"), /proof-of-concept boundary/);
});
