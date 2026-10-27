import assert from "node:assert/strict";
import test from "node:test";
import {
  explainProviderError,
  isFreeTierExhausted,
  isRetryableProviderError,
  retryAfterMs,
  retryDelayMs,
  withProviderRetry,
} from "../src/utils/llm/retry";

function httpError(status: number, message = "error", headers?: Record<string, string>) {
  return Object.assign(new Error(message), { status, headers });
}

test("a 429 is retried and the next attempt's result is returned", async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await withProviderRetry(
    async () => {
      calls++;
      if (calls < 3) throw httpError(429, "rate limit exceeded");
      return "ok";
    },
    { sleep: async (ms) => void waits.push(ms) },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
});

test("the 5xx family is transient and retried, a 4xx is not", async () => {
  let calls = 0;
  await withProviderRetry(
    async () => {
      calls++;
      if (calls === 1) throw httpError(503, "upstream reconnecting");
      return "ok";
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    withProviderRetry(
      async () => {
        calls++;
        throw httpError(401, "invalid_api_key");
      },
      { sleep: async () => {} },
    ),
    /invalid_api_key/,
  );
  assert.equal(calls, 1, "a bad key fails the same way on every attempt");
});

test("retrying stops after the attempt budget and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withProviderRetry(
      async () => {
        calls++;
        throw httpError(429, "rate limit exceeded");
      },
      { maxAttempts: 3, sleep: async () => {} },
    ),
    /rate limit/,
  );
  assert.equal(calls, 3);
});

test("a spent daily allowance fails fast instead of retrying for hours", async () => {
  let calls = 0;
  const raw = httpError(
    429,
    '[429]: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}',
  );

  await assert.rejects(
    withProviderRetry(
      async () => {
        calls++;
        throw raw;
      },
      { sleep: async () => {} },
    ),
    /Free usage limit/,
  );
  assert.equal(calls, 1, "the quota refills on a daily boundary, not in seconds");
});

test("Retry-After wins over the backoff, in seconds or as an HTTP date", () => {
  assert.equal(retryAfterMs({ headers: { "retry-after": "7" } }), 7000);
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "2" }) }), 2000);

  const inFiveSeconds = new Date(Date.now() + 5000).toUTCString();
  const delay = retryAfterMs({ headers: { "retry-after": inFiveSeconds } });
  assert.ok(delay !== undefined && delay > 3000 && delay <= 5000, String(delay));

  // A server asking for longer than a chat turn can absorb is capped.
  assert.equal(retryDelayMs({ headers: { "retry-after": "600" } }, 0), 15_000);
  assert.equal(retryDelayMs({ headers: { "retry-after": "0" } }, 0), 0);
});

test("a stream that already emitted a delta is not retried", async () => {
  let calls = 0;
  const emitted = { value: false };
  await assert.rejects(
    withProviderRetry(
      async () => {
        calls++;
        emitted.value = true;
        throw httpError(429, "rate limit exceeded");
      },
      { canRetry: () => !emitted.value, sleep: async () => {} },
    ),
    /rate limit/,
  );
  assert.equal(calls, 1);
});

test("aborting during the wait stops the retry", async () => {
  const controller = new AbortController();
  const err = httpError(429, "rate limit exceeded");

  await assert.rejects(
    withProviderRetry(
      async () => {
        throw err;
      },
      {
        abortSignal: controller.signal,
        sleep: async () => {
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        },
      },
    ),
    (thrown: any) => thrown.name === "AbortError",
  );
});

test("the free-tier refusal becomes a message the operator can act on", () => {
  const raw = httpError(
    429,
    '[429]: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}',
  );
  const friendly = explainProviderError(raw);
  assert.match(friendly.message, /spent until the daily reset/);
  assert.match(friendly.message, /calling IP address/);
  assert.match(friendly.message, /OpenCode Go|paid provider/);
  assert.equal(friendly.status, 429);
  assert.equal(friendly.code, "free_tier_exhausted");

  const other = httpError(500, "upstream is down");
  assert.equal(explainProviderError(other), other, "unrelated errors pass through");
});

test("retryable classification covers 429 and 5xx but not an exhausted allowance", () => {
  assert.equal(isRetryableProviderError(httpError(429)), true);
  assert.equal(isRetryableProviderError(httpError(502)), true);
  assert.equal(isRetryableProviderError(httpError(400)), false);
  assert.equal(isRetryableProviderError(new Error("FreeUsageLimitError")), false);
  assert.equal(isFreeTierExhausted(new Error("FreeUsageLimitError")), true);
});
