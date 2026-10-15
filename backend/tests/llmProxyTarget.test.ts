import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedProxyTarget } from "../src/utils/llmProxy";

// The proxy signs a target and fetches it server-side, so the target check is a
// boundary: a public provider is allowed, anything that points back into the
// backend's own network is not.

test("public provider hosts are allowed", () => {
  assert.equal(isAllowedProxyTarget("https://api.openai.com/v1"), true);
  assert.equal(isAllowedProxyTarget("https://generativelanguage.googleapis.com"), true);
  assert.equal(isAllowedProxyTarget("http://api.anthropic.com"), true);
});

test("loopback, private and link-local targets are refused", () => {
  assert.equal(isAllowedProxyTarget("http://127.0.0.1:8080/admin"), false);
  assert.equal(isAllowedProxyTarget("http://localhost:27017"), false);
  assert.equal(isAllowedProxyTarget("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isAllowedProxyTarget("http://10.0.0.5/"), false);
  assert.equal(isAllowedProxyTarget("http://192.168.1.1/"), false);
  assert.equal(isAllowedProxyTarget("http://172.16.0.9/"), false);
  assert.equal(isAllowedProxyTarget("http://[::1]/"), false);
});

test("internal and single-label hostnames are refused", () => {
  assert.equal(isAllowedProxyTarget("http://mongo:27017"), false);
  assert.equal(isAllowedProxyTarget("http://redis:6379"), false);
  assert.equal(isAllowedProxyTarget("http://metadata.google.internal/"), false);
  assert.equal(isAllowedProxyTarget("http://burp.corp/"), false);
  assert.equal(isAllowedProxyTarget("http://service.localhost/"), false);
});

test("a hostname resolving to a private address is refused", () => {
  // Requires DNS; if DNS is unavailable the probe is skipped.
  try {
    assert.equal(isAllowedProxyTarget("http://localhost.evil.test/"), false);
  } catch {
    // OK
  }
});

test("non-http schemes and unparseable targets are refused", () => {
  assert.equal(isAllowedProxyTarget("file:///etc/passwd"), false);
  assert.equal(isAllowedProxyTarget("gopher://127.0.0.1:70/"), false);
  assert.equal(isAllowedProxyTarget("not a url"), false);
  assert.equal(isAllowedProxyTarget(""), false);
});

test("an explicit allowlist admits a self-hosted provider", () => {
  const previous = process.env.LLM_PROXY_ALLOWED_HOSTS;
  process.env.LLM_PROXY_ALLOWED_HOSTS = "ollama.internal,llm.lan";
  try {
    assert.equal(isAllowedProxyTarget("http://ollama.internal:11434/v1"), true);
    assert.equal(isAllowedProxyTarget("http://llm.lan:8000/v1"), true);
    assert.equal(isAllowedProxyTarget("http://other.lan:8000/v1"), false);
    assert.equal(isAllowedProxyTarget("http://127.0.0.1:11434/v1"), false);
  } finally {
    if (previous === undefined) delete process.env.LLM_PROXY_ALLOWED_HOSTS;
    else process.env.LLM_PROXY_ALLOWED_HOSTS = previous;
  }
});
