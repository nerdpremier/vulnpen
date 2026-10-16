import assert from "node:assert/strict";
import test from "node:test";
import { scrubErrorForLog } from "../src/utils/scrubErrorForLog";

/**
 * The shape body-parser produces for a rejected body. Reproduced from a real
 * log line captured against a running backend:
 *
 *   SyntaxError: Bad escaped character in JSON at position 9 (line 1 column 10)
 *     statusCode: 400,
 *     body: '{" email\:\admin@admin.com\,\password\:\12345678\}',
 *     type: 'entity.parse.failed'
 *
 * The `body` is what must never reach a log.
 */
function bodyParserParseError(): SyntaxError {
  return Object.assign(
    new SyntaxError("Bad escaped character in JSON at position 9 (line 1 column 10)"),
    {
      body: '{" email\\:\\admin@admin.com\\,\\password\\:\\12345678\\}',
      type: "entity.parse.failed",
      statusCode: 400,
      status: 400,
      expose: true,
    },
  );
}

test("the raw request body is dropped", () => {
  const logged = scrubErrorForLog(bodyParserParseError());

  assert.equal(Object.prototype.hasOwnProperty.call(logged, "body"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(logged, "expose"), false);
});

test("a scrubbed credential-bearing error cannot leak through serialisation", () => {
  const forBodyRejection = scrubErrorForLog(bodyParserParseError());
  const withStack = scrubErrorForLog(bodyParserParseError(), true);

  for (const logged of [forBodyRejection, withStack]) {
    const rendered = `${JSON.stringify(logged)} ${String(logged.message)}`;
    assert.equal(rendered.includes("12345678"), false);
    assert.equal(rendered.includes("admin@admin.com"), false);
    assert.equal(rendered.includes("password"), false);
  }
});

test("the diagnostics worth keeping survive", () => {
  const logged = scrubErrorForLog(bodyParserParseError());

  assert.equal(logged.name, "SyntaxError");
  assert.equal(logged.type, "entity.parse.failed");
  assert.equal(logged.status, 400);
  assert.match(logged.message ?? "", /position 9/);
  assert.equal(logged.stack, undefined);
});

test("the stack is available on request, and only on request", () => {
  const withStack = scrubErrorForLog(bodyParserParseError(), true);

  assert.equal(typeof withStack.stack, "string");
  assert.match(withStack.stack ?? "", /SyntaxError/);
  assert.equal(withStack.stack?.includes("12345678"), false);
  assert.equal(withStack.stack?.includes("admin@admin.com"), false);
});

test("an ordinary error keeps name, message and code", () => {
  const logged = scrubErrorForLog(Object.assign(new Error("boom"), { code: 11000 }));

  assert.equal(logged.name, "Error");
  assert.equal(logged.message, "boom");
  assert.equal(logged.code, 11000);
  assert.equal(logged.status, undefined);
});

test("a thrown non-object still produces something loggable", () => {
  assert.deepEqual(scrubErrorForLog("just a string"), { message: "just a string" });
  assert.deepEqual(scrubErrorForLog(undefined), { message: "undefined" });
  assert.deepEqual(scrubErrorForLog(null), { message: "null" });
});

test("fields of the wrong type are not copied in", () => {
  const logged = scrubErrorForLog({
    message: "ok",
    status: "400",
    statusCode: { nested: true },
    code: { evil: true },
    body: "secret",
  });

  assert.deepEqual(logged, { message: "ok" });
});
