import { test } from "node:test";
import assert from "node:assert/strict";
import { BURP_HANDOFF_KEY, buildBurpMessage, takeBurpHandoff } from "./burpHandoff.mjs";

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

test("takeBurpHandoff reads, removes and parses the pending payload", () => {
  const storage = fakeStorage({ [BURP_HANDOFF_KEY]: JSON.stringify({ host: "example.com" }) });
  const parsed = takeBurpHandoff(storage);
  assert.deepEqual(parsed, { host: "example.com" });
  assert.equal(storage.getItem(BURP_HANDOFF_KEY), null);
});

test("takeBurpHandoff returns null for nothing pending or a broken payload", () => {
  assert.equal(takeBurpHandoff(fakeStorage()), null);
  assert.equal(takeBurpHandoff(fakeStorage({ [BURP_HANDOFF_KEY]: "{not json" })), null);
});

test("buildBurpMessage frames the request with the operator's own text", () => {
  const { text, burpMeta } = buildBurpMessage("Check auth on this", {
    method: "POST",
    host: "example.com",
    path: "/login",
    port: 8443,
    secure: true,
    rawRequest: "POST /login HTTP/1.1",
    rawResponse: "HTTP/1.1 200",
    statusCode: 200,
  });
  assert.match(text, /^Check auth on this\n\n/);
  assert.match(text, /Target: POST https:\/\/example\.com\/login/);
  assert.match(text, /Port: 8443 \| TLS: Yes/);
  assert.match(text, /--- RAW REQUEST ---/);
  assert.match(text, /--- RAW RESPONSE ---/);
  assert.deepEqual(burpMeta, {
    method: "POST",
    host: "example.com",
    path: "/login",
    port: 8443,
    secure: true,
    statusCode: 200,
  });
});

test("buildBurpMessage supplies a default ask when the operator wrote nothing", () => {
  const { text } = buildBurpMessage("", {
    method: "GET",
    host: "example.com",
    path: "/",
    secure: false,
    rawRequest: "",
  });
  assert.match(text, /Analyze and pentest the following HTTP request/);
  assert.match(text, /http:\/\/example\.com\//);
  assert.match(text, /\(empty\)/);
  assert.match(text, /Analyze this request for potential vulnerabilities/);
  assert.doesNotMatch(text, /RAW RESPONSE/);
});
