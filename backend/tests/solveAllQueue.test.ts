import assert from "node:assert/strict";
import test from "node:test";
import {
  abortSession,
  hasActiveController,
} from "../src/services/agent-controller-registry";
import {
  reserveSolveTarget,
  runReservedSolveQueue,
} from "../src/services/solve-all-queue";

test("queued solves reject duplicate starts and release reservations after failure", async () => {
  const sessionId = "solve-all-queue-test";
  abortSession(sessionId);

  const target = reserveSolveTarget(sessionId, "Challenge One");
  assert.ok(target);
  assert.equal(reserveSolveTarget(sessionId, "Challenge One"), null);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runReservedSolveQueue([target], 1, async () => {
      throw new Error("detached failure");
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(hasActiveController(sessionId), false);
});

test("the reserved solve queue preserves its concurrency limit", async () => {
  const sessionIds = Array.from(
    { length: 4 },
    (_, index) => `solve-all-limit-test-${index}`,
  );
  const targets = sessionIds.map((sessionId, index) => {
    abortSession(sessionId);
    const target = reserveSolveTarget(sessionId, `Challenge ${index}`);
    assert.ok(target);
    return target;
  });

  let active = 0;
  let maxActive = 0;
  await runReservedSolveQueue(targets, 2, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
  });

  assert.equal(maxActive, 2);
  for (const sessionId of sessionIds) {
    assert.equal(hasActiveController(sessionId), false);
  }
});
