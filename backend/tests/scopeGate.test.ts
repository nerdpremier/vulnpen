import assert from "node:assert/strict";
import test from "node:test";
import { checkScope, declaredScopeHosts, extractCommandHosts, parseScopeHosts } from "../src/utils/scopeGate";

const allowlist = parseScopeHosts(
  "in-scope: http://juice-shop:3000 and 10.0.0.5, excluded: corporate.example.com",
);

test("scope parsing captures urls, ips and docker hostnames", () => {
  assert.ok(allowlist.includes("juice-shop"));
  assert.ok(allowlist.includes("10.0.0.5"));
  assert.ok(allowlist.includes("corporate.example.com"));
  assert.ok(allowlist.includes("localhost"));
});

test("commands inside scope pass the deterministic gate", () => {
  for (const command of [
    "curl -s http://juice-shop:3000/rest/products/1",
    "nmap -sV 10.0.0.5",
    "sqlmap -u http://juice-shop:3000/login --batch",
    "ffuf -u https://juice-shop:3000/FUZZ -w list.txt",
  ]) {
    assert.deepEqual(checkScope(command, allowlist).outside, [], command);
  }
});

test("commands aimed outside scope are flagged", () => {
  for (const command of [
    "curl -s https://third-party.example.net/payload",
    "nmap -sV 10.9.9.9",
    "sqlmap -u http://other-app.internal/admin --batch",
  ]) {
    assert.ok(checkScope(command, allowlist).outside.length > 0, command);
  }
});

test("subdomains of an in-scope domain are covered", () => {
  const allow = parseScopeHosts("scope: example.test");
  assert.deepEqual(checkScope("curl http://api.example.test/x", allow).outside, []);
});

test("empty allowlist abstains instead of blocking everything", () => {
  assert.deepEqual(checkScope("curl https://anything.test", []).outside, []);
});

test("host extraction stays precise", () => {
  const hosts = extractCommandHosts("curl -s 'http://juice-shop:3000/?next=http://10.1.2.3/x' -d @p.json");
  assert.ok(hosts.includes("juice-shop"));
  assert.ok(hosts.includes("10.1.2.3"));
});

test("declaredScopeHosts: declared target yields a non-local allowlist seed", () => {
  const hosts = declaredScopeHosts("http://juice-shop:3000 Storefront, REST API");
  assert.deepEqual(hosts, ["juice-shop"]);
});

test("declaredScopeHosts: no declared target means the gate must abstain", () => {
  assert.deepEqual(declaredScopeHosts(undefined, undefined), []);
  assert.deepEqual(declaredScopeHosts("", ""), []);
  // Local-only targets are not a boundary either.
  assert.deepEqual(declaredScopeHosts("http://localhost:8080"), []);
  // Prose in the scope text is not a declared host.
  assert.deepEqual(declaredScopeHosts("Storefront, REST API, admin"), []);
});

test("declaredScopeHosts: a docker-style host:port target still arms the gate", () => {
  assert.deepEqual(declaredScopeHosts("juice-shop:3000"), ["juice-shop"]);
  assert.deepEqual(declaredScopeHosts("", "juice-shop:3000"), ["juice-shop"]);
  // IP with an explicit port is equally a declared target.
  assert.deepEqual(declaredScopeHosts("10.0.0.5:8080"), ["10.0.0.5"]);
});

test("an address inside a URL path is part of that request, not a target", () => {
  const allow = ["api.shodan.io", "crt.sh"];
  for (const command of [
    "curl -s https://api.shodan.io/shodan/host/1.2.3.4",
    'curl -s "https://crt.sh/?q=1.2.3.4"',
  ]) {
    assert.deepEqual(checkScope(command, allow).outside, [], command);
  }
});

test("an address that is a nested URL host is still a target", () => {
  const hosts = extractCommandHosts("curl 'http://a.test/?next=http://10.1.2.3/x'");
  assert.ok(hosts.includes("10.1.2.3"), hosts.join(","));
});

test("a bare address argument is still a target", () => {
  assert.deepEqual(extractCommandHosts("nmap -sV 8.8.8.8"), ["8.8.8.8"]);
});

test("a bare hostname argument is deliberately not extracted", () => {
  // Precision over recall: bare words are ambiguous, so they are not targets.
  // The boundary still holds because probing tooling is what gets escalated.
  assert.deepEqual(extractCommandHosts("nmap -sV third-party.example.net"), []);
});
