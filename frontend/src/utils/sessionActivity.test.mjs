import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, summariseSessionActivity, toolCallState } from "./sessionActivity.mjs";

function fakeToolIndex(outputs) {
  return { outputs: new Map(Object.entries(outputs)) };
}

test("toolCallState: no output or streaming is running, exit code decides the rest", () => {
  assert.equal(toolCallState(undefined), "running");
  assert.equal(toolCallState({ streaming: true, exitCode: 1 }), "running");
  assert.equal(toolCallState({ exitCode: null }), "settled");
  assert.equal(toolCallState({ exitCode: 0 }), "succeeded");
  assert.equal(toolCallState({ exitCode: 2 }), "failed");
});

test("activity counts calls by outcome and names the tools carrying the work", () => {
  const messages = [
    { role: "user", timestamp: "2026-10-07T10:00:00Z" },
    {
      role: "assistant",
      timestamp: "2026-10-07T10:01:00Z",
      toolCalls: [
        { id: "a", name: "run_bash" },
        { id: "b", name: "run_bash" },
        { id: "c", name: "write_to_shell" },
        { id: "d", name: "read_shell" },
      ],
    },
  ];
  const activity = summariseSessionActivity(
    messages,
    fakeToolIndex({
      a: { exitCode: 0 },
      b: { exitCode: 1 },
      c: { exitCode: 0 },
      // d has no output: still running
    }),
  );
  assert.equal(activity.calls, 4);
  assert.equal(activity.succeeded, 2);
  assert.equal(activity.failed, 1);
  assert.equal(activity.running, 1);
  assert.deepEqual(
    activity.tools.map((row) => row.label),
    ["run_bash", "read_shell", "write_to_shell"],
  );
  assert.equal(activity.tools[0].tone, "danger");
  assert.equal(activity.tools[1].tone, "success");
});

test("activity measures the wall-clock span from first to last timestamp", () => {
  const activity = summariseSessionActivity(
    [
      { role: "user", timestamp: "2026-10-07T10:00:00Z" },
      { role: "assistant", timestamp: "2026-10-07T10:02:00Z" },
    ],
    fakeToolIndex({}),
  );
  assert.equal(activity.elapsedMs, 120_000);
});

test("a transcript without calls or timestamps yields an empty, timeless readout", () => {
  const activity = summariseSessionActivity(
    [{ role: "user", content: "hi" }],
    fakeToolIndex({}),
  );
  assert.equal(activity.calls, 0);
  assert.equal(activity.elapsedMs, null);
  assert.deepEqual(activity.tools, []);
});

test("formatElapsed rounds to the unit a human reads", () => {
  assert.equal(formatElapsed(5_400), "5s");
  assert.equal(formatElapsed(90_000), "1m");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(null), "—");
});
