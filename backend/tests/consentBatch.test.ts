import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingConsentBatch,
  consentRequiredEvent,
  loadPendingConsent,
} from "../src/services/consent-batch";
import type { ToolExecutionResult } from "../src/services/agent.tools";
import type { ToolCallData } from "../src/utils/llm/providers";

function consentResult(id: string, name: string): ToolExecutionResult {
  return {
    toolCallId: id,
    toolName: name,
    result: { output: "", exitCode: 0 },
    needsConsent: true,
    safetyBlock: true,
    approvalReason: "destructive action",
    safetyReason: "เหตุผล",
    safetyImpact: "ผลกระทบ",
    safetyKind: "destructive_target",
  };
}

function call(id: string, name: string, args: string): ToolCallData {
  return { id, name, arguments: args } as ToolCallData;
}

test("the persisted batch and the resumed batch are the same shape (round trip)", () => {
  const calls = [
    call("c1", "run_bash", '{"command":"rm -rf /"}'),
    call("c2", "run_bash", '{"command":"dd if=/dev/zero of=/dev/sda"}'),
  ];
  const results = [consentResult("c1", "run_bash"), consentResult("c2", "run_bash")];

  const batch = buildPendingConsentBatch(results, calls);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].arguments.command, "rm -rf /");

  // The persist side wraps a multi-call batch under `batch`; the load side
  // must unpack exactly it — no re-derivation of arguments allowed.
  const persisted = consentRequiredEvent(batch);
  const doc = {
    toolCallId: persisted.id,
    toolName: persisted.name,
    arguments: persisted.args,
    safetyBlock: persisted.safetyBlock,
    batch: persisted.batch,
  };
  const resumed = loadPendingConsent(doc as never);
  assert.deepEqual(resumed, batch);
});

test("a lone consent call persists flat and resumes as a one-item list", () => {
  const calls = [call("c1", "run_bash", '{"command":"nmap -sV 10.0.0.1"}')];
  const batch = buildPendingConsentBatch([consentResult("c1", "run_bash")], calls);
  const event = consentRequiredEvent(batch);

  assert.equal(event.batch, undefined, "a single call must not carry a batch array");
  const resumed = loadPendingConsent({
    toolCallId: event.id,
    toolName: event.name,
    arguments: event.args,
    safetyBlock: event.safetyBlock,
  } as never);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].toolCallId, "c1");
  assert.equal(resumed[0].arguments.command, "nmap -sV 10.0.0.1");
});
