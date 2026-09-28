import assert from "node:assert/strict";
import test from "node:test";
import {
  abortSession,
  hasActiveController,
  releaseAbortController,
  reserveAbortController,
} from "../src/services/agent-controller-registry";

test("controller reservations reject duplicate starts until released", () => {
  const sessionId = "controller-reservation-test";
  abortSession(sessionId);

  const first = reserveAbortController(sessionId);
  assert.ok(first);
  assert.equal(hasActiveController(sessionId), true);
  assert.equal(reserveAbortController(sessionId), null);

  releaseAbortController(sessionId, first);
  assert.equal(hasActiveController(sessionId), false);
});

test("an aborted reservation remains claimed until its owner releases it", () => {
  const sessionId = "controller-owner-test";
  abortSession(sessionId);

  const first = reserveAbortController(sessionId);
  assert.ok(first);
  abortSession(sessionId);
  assert.equal(hasActiveController(sessionId), false);
  assert.equal(reserveAbortController(sessionId), null);

  releaseAbortController(sessionId, first);
  const second = reserveAbortController(sessionId);
  assert.ok(second);
  releaseAbortController(sessionId, first);
  assert.equal(hasActiveController(sessionId), true);

  releaseAbortController(sessionId, second);
  assert.equal(hasActiveController(sessionId), false);
});
