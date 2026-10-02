import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserLlmErrorHint,
  isTransientBrowserLlmFailure,
} from "../src/utils/magnitudeError";

test("transient provider failures are classified for retry", () => {
  assert.ok(isTransientBrowserLlmFailure("BamlClientHttpError: Request failed with status code: 429"));
  assert.ok(isTransientBrowserLlmFailure("status code: 503 Service Unavailable"));
  assert.ok(isTransientBrowserLlmFailure("rate limit exceeded, too many requests"));
  assert.ok(!isTransientBrowserLlmFailure("status code: 404 Not Found"));
  assert.ok(!isTransientBrowserLlmFailure("X server missing"));
  assert.ok(!isTransientBrowserLlmFailure(""));
});

test("persistent LLM failures carry an actionable hint", () => {
  const gone = browserLlmErrorHint(
    "BamlClientHttpError: Request failed with status code: 404 Not Found",
    "Bunny",
  );
  assert.match(gone, /unavailable at its provider \(404\)/);
  assert.match(gone, /Settings → Models/);

  const limited = browserLlmErrorHint(
    "BamlClientHttpError: Request failed with status code: 429",
    "Bunny",
  );
  assert.match(limited, /rate limited/);
  assert.match(limited, /dedicated model/);

  // non-LLM errors stay untouched
  assert.equal(browserLlmErrorHint("X server missing", "Bunny"), "");
});
