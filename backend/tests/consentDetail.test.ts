import assert from "node:assert/strict";
import test from "node:test";
import { scopeAllowlistFromContext, shellSafetyDetail } from "../src/utils/consentDetail";
import { EngagementState } from "../src/services/engagement-state";

// Mirrors buildEngagementState: the Target arms the gate, the joined free text
// is what the gate parses into the allowlist.
function stateWith(declaredTarget: string, scopeText: string) {
  const state = new EngagementState();
  state.declaredTarget = declaredTarget;
  state.scope = [declaredTarget, scopeText].filter(Boolean).join(" ");
  return state;
}

function ctx(declaredTarget: string, scopeText = "") {
  return { engagementState: stateWith(declaredTarget, scopeText) } as any;
}

const IN_SCOPE_CMD = "curl -s http://juice-shop:3000/rest/products/search?q=test";

test("the declared target arms the gate and stays inside it", () => {
  const context = ctx("juice-shop:3000");
  assert.equal(scopeAllowlistFromContext(context).includes("juice-shop"), true);
  assert.equal(shellSafetyDetail(IN_SCOPE_CMD, context), undefined);
});

test("scope prose alone never arms the gate", () => {
  const context = ctx("", "out of scope: legacy.example.com");
  assert.deepEqual(scopeAllowlistFromContext(context), []);
  assert.equal(shellSafetyDetail(IN_SCOPE_CMD, context), undefined);
});

test("reading public sources is reconnaissance, not a boundary crossing", () => {
  // OSINT must not need the user to enumerate every public domain first.
  for (const command of [
    "curl -s https://crt.sh/?q=example.com",
    "curl -s https://www.google.com/search?q=site:example.com",
    "curl -s https://api.shodan.io/shodan/host/1.2.3.4",
    "whois example.com",
    "dig example.com +short",
  ]) {
    assert.equal(shellSafetyDetail(command, ctx("juice-shop:3000")), undefined, command);
  }
});

test("probing or writing to a host that is not the target crosses the boundary", () => {
  for (const command of [
    "sqlmap -u https://third-party.example.net/login --batch",
    "curl -s -X POST -d 'user=admin' https://third-party.example.net/login",
    "nmap -sV 10.20.30.40",
  ]) {
    assert.equal(
      shellSafetyDetail(command, ctx("juice-shop:3000"))?.kind,
      "out_of_scope",
      command,
    );
  }
});

test("an internal host is never treated as public reconnaissance", () => {
  for (const command of [
    "curl -s https://erp.internal/api/users",
    "curl -s http://10.20.30.40/status",
    "curl -s http://neighbour-box/x",
  ]) {
    assert.equal(
      shellSafetyDetail(command, ctx("juice-shop:3000"))?.kind,
      "out_of_scope",
      command,
    );
  }
});

test("a destructive command on the attack box no longer gates consent", () => {
  // The box is disposable test infrastructure — the user cut this category.
  const detail = shellSafetyDetail("rm --recursive --force /", ctx("juice-shop:3000"));
  assert.equal(detail, undefined);
});
