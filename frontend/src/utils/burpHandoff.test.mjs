import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BURP_HANDOFF_KEY,
  buildBurpMessage,
  takeBurpHandoff,
  stashBurpHandoff,
  subscribeBurpHandoff,
} from "./burpHandoff.mjs";

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

/**
 * A stand-in for `window` with just the EventTarget surface the handoff uses.
 * Node has no global `CustomEvent`, so one is shimmed rather than pulling in a
 * DOM: the module only ever constructs a bare, detail-less event.
 */
function fakeWindow() {
  const listeners = new Map();
  return {
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const fns = listeners.get(type) ?? [];
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    },
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

test("stashBurpHandoff stores the payload and announces it", () => {
  globalThis.CustomEvent ??= class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
  const storage = fakeStorage();
  const win = fakeWindow();
  let heard = 0;
  subscribeBurpHandoff(() => heard++, win);

  stashBurpHandoff({ host: "example.com" }, { storage, target: win });

  assert.equal(heard, 1, "the mounted chat hears the handoff without a remount");
  assert.deepEqual(JSON.parse(storage.getItem(BURP_HANDOFF_KEY)), { host: "example.com" });
});

test("subscribeBurpHandoff stops delivering once unsubscribed", () => {
  globalThis.CustomEvent ??= class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
  const win = fakeWindow();
  let heard = 0;
  const unsubscribe = subscribeBurpHandoff(() => heard++, win);
  unsubscribe();

  stashBurpHandoff({ host: "example.com" }, { storage: fakeStorage(), target: win });

  assert.equal(heard, 0);
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
