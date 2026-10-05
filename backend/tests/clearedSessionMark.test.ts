import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markSessionCleared,
  wasSessionClearedSince,
} from "../src/services/session.helpers";

test("a cleared session is only marked at and after its clear time", () => {
  const sessionId = `s_${Math.random()}`;
  assert.equal(
    wasSessionClearedSince(sessionId, 0),
    false,
    "a session that was never cleared is never live-suppressing",
  );

  markSessionCleared(sessionId);
  // `0` stands in for any run-start instant at or before the mark: that run's
  // flushes are suppressed.
  assert.equal(wasSessionClearedSince(sessionId, 0), true);
  // A `since` strictly after the mark (here: the far future) is not.
  assert.equal(
    wasSessionClearedSince(sessionId, Number.MAX_SAFE_INTEGER),
    false,
    "a run that started after the clear flushes normally",
  );
});

test("marks are per session", () => {
  const a = `a_${Math.random()}`;
  const b = `b_${Math.random()}`;
  markSessionCleared(a);
  assert.equal(wasSessionClearedSince(b, 0), false, "the other session is untouched");
  assert.equal(wasSessionClearedSince(a, 0), true);
});
