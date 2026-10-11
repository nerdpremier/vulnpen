import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/utils/rateLimiter";

test("blocks only after the maximum number of attempts in the window", () => {
  const limited = createRateLimiter(3, 1000, () => 0);
  assert.equal(limited("a"), false);
  assert.equal(limited("a"), false);
  assert.equal(limited("a"), false);
  assert.equal(limited("a"), true);
});

test("keys are counted independently", () => {
  const limited = createRateLimiter(1, 1000, () => 0);
  assert.equal(limited("a"), false);
  assert.equal(limited("a"), true);
  assert.equal(limited("b"), false);
});

test("the window resets once it has elapsed", () => {
  let t = 0;
  const limited = createRateLimiter(1, 1000, () => t);
  assert.equal(limited("a"), false);
  assert.equal(limited("a"), true);
  t = 1000;
  assert.equal(limited("a"), false);
});
