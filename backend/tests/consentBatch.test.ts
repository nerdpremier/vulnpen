import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingConsentBatch,
  consentRequiredEvent,
  loadPendingConsent,
  splitConsentBatch,
} from "../src/services/consent-batch";
import type { ToolExecutionResult } from "../src/services/agent.tools";
import type { ToolCallData } from "../src/utils/llm/types";

function consentResult(id: string, name: string): ToolExecutionResult {
  return {
    kind: "consent_required",
    toolCallId: id,
    toolName: name,
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

/** The two-item parked batch the per-item approval tests work from. */
function parkedBatch() {
  const calls = [
    call("c1", "run_bash", '{"command":"curl -I http://target/"}'),
    call("c2", "run_bash", '{"command":"apt-get install -y sqlmap"}'),
  ];
  const results = [consentResult("c1", "run_bash"), consentResult("c2", "run_bash")];
  return buildPendingConsentBatch(results, calls);
}

test("an approval with no ids runs the whole parked batch", () => {
  const batch = parkedBatch();
  const { allowed, refused } = splitConsentBatch(batch, true);

  assert.deepEqual(allowed.map((item) => item.toolCallId), ["c1", "c2"]);
  assert.deepEqual(refused, []);
});

test("per-item approval runs exactly the ticked actions and refuses the rest", () => {
  const batch = parkedBatch();
  const { allowed, refused } = splitConsentBatch(batch, true, ["c1"]);

  assert.deepEqual(allowed.map((item) => item.toolCallId), ["c1"]);
  assert.deepEqual(refused.map((item) => item.toolCallId), ["c2"]);
});

test("an empty ticked set approves nothing rather than everything", () => {
  // The dangerous reading of an empty checkbox list is "run it all"; it must
  // stay the safe one (it is what a mis-rendered list sends).
  const batch = parkedBatch();
  const { allowed, refused } = splitConsentBatch(batch, true, []);

  assert.deepEqual(allowed, []);
  assert.deepEqual(refused.map((item) => item.toolCallId), ["c1", "c2"]);
});

test("ids the parked batch does not contain can only refuse, never add", () => {
  const batch = parkedBatch();
  const { allowed, refused } = splitConsentBatch(batch, true, [
    "c1",
    "not-in-the-batch",
  ]);

  assert.deepEqual(allowed.map((item) => item.toolCallId), ["c1"]);
  assert.deepEqual(refused.map((item) => item.toolCallId), ["c2"]);
});

test("a denial refuses every item whatever ids were sent", () => {
  const batch = parkedBatch();
  const { allowed, refused } = splitConsentBatch(batch, false, ["c1"]);

  assert.deepEqual(allowed, []);
  assert.deepEqual(refused.map((item) => item.toolCallId), ["c1", "c2"]);
});
