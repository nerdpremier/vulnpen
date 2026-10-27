import assert from "node:assert/strict";
import test from "node:test";
import {
  browserActionSafetyDetail,
  rawRequestSafetyDetail,
  scopeAllowlistFromContext,
  scriptSafetyDetail,
  shellSafetyDetail,
} from "../src/utils/consentDetail";
import { EngagementState } from "../src/services/engagement-state";

/**
 * Out-of-scope execution coverage.
 *
 * The scope gate is the rule that stops an engagement from drifting onto a host
 * the client never authorised. It has one documented fail-open: with no declared
 * Target there is nothing to check against, so it abstains. Everything else is
 * about whether each execution path — a shell command, a Python script, a raw
 * Burp request, a browser goal — actually reaches the gate, and whether a
 * target can be smuggled past the extraction.
 */

function stateWith(declaredTarget: string, scopeText = "") {
  const state = new EngagementState();
  state.declaredTarget = declaredTarget;
  state.scope = [declaredTarget, scopeText].filter(Boolean).join(" ");
  return state;
}

function ctx(declaredTarget: string, scopeText = "") {
  return { engagementState: stateWith(declaredTarget, scopeText) } as any;
}

const TARGET = "juice-shop:3000";

test("every execution path reaches the scope gate", () => {
  const context = ctx(TARGET);
  // An internal host: public read-only reconnaissance is exempt by design, so
  // an internal name is what isolates "did this path reach the gate at all".
  const outside = "http://erp.internal";

  assert.equal(
    shellSafetyDetail(`nmap -sV ${outside}`, context)?.kind,
    "out_of_scope",
    "shell command",
  );
  assert.equal(
    scriptSafetyDetail(`import subprocess\nsubprocess.run(["nmap", "-sV", "${outside}"])`, context)?.kind,
    "out_of_scope",
    "python script",
  );
  assert.equal(
    shellSafetyDetail(`nmap -sV ${outside}`, context)?.kind,
    "out_of_scope",
    "shell input",
  );
  assert.equal(
    rawRequestSafetyDetail(
      { host: "erp.internal", raw_request: "GET /x HTTP/1.1\r\nHost: erp.internal\r\n" },
      context,
    )?.kind,
    "out_of_scope",
    "raw Burp request",
  );
  assert.equal(
    browserActionSafetyDetail({ url: `${outside}/x`, goal: "read the page" }, context)?.kind,
    "out_of_scope",
    "browser goal",
  );
});

test("the target cannot be hidden from the extractor", () => {
  for (const command of [
    "nmap -sV 10.9.9.9",
    "sudo nmap -sV 10.9.9.9",
    "bash -c 'nmap -sV 10.9.9.9'",
    "echo $(nmap -sV 10.9.9.9)",
    "sqlmap -u http://other-app.internal/admin --batch",
    "ffuf -u https://third-party.example.net/FUZZ -w list.txt",
    "curl -s http://erp.internal/x",
    "curl -s -X POST -d a=1 http://third-party.example.net/x",
    "curl --url http://erp.internal/x -d a=1",
  ]) {
    assert.equal(shellSafetyDetail(command, ctx(TARGET))?.kind, "out_of_scope", command);
  }
});

test("in-scope work stays automatic", () => {
  for (const command of [
    `curl -s http://${TARGET}/rest/products/1`,
    "nmap -sV 10.0.0.5",
    `sqlmap -u http://${TARGET}/login --batch`,
    `ffuf -u https://${TARGET}/FUZZ -w list.txt`,
  ]) {
    assert.equal(shellSafetyDetail(command, ctx(TARGET, "10.0.0.5")), undefined, command);
  }
});

test("public read-only reconnaissance is not an out-of-scope execution", () => {
  // Reading a public page is reconnaissance, not testing — the operator must not
  // have to enumerate every public source before the agent may look one up.
  for (const command of [
    "curl -s https://crt.sh/?q=example.com",
    "dig example.com +short",
    "whois example.com",
  ]) {
    assert.equal(shellSafetyDetail(command, ctx(TARGET)), undefined, command);
  }
  // …but a tool that probes, or a request that writes, is testing.
  assert.equal(
    shellSafetyDetail("sqlmap -u https://crt.sh/?q=x --batch", ctx(TARGET))?.kind,
    "out_of_scope",
  );
  assert.equal(
    shellSafetyDetail("curl -s -X POST -d a=1 https://crt.sh/x", ctx(TARGET))?.kind,
    "out_of_scope",
  );
});

test("an internal host is never treated as public reconnaissance", () => {
  for (const command of [
    "curl -s https://erp.internal/api/users",
    "curl -s http://10.20.30.40/status",
    "curl -s http://neighbour-box/x",
  ]) {
    assert.equal(shellSafetyDetail(command, ctx(TARGET))?.kind, "out_of_scope", command);
  }
});

test("with no declared target the gate abstains, by design", () => {
  // Documented fail-open: the Target is the only field that arms the gate, so a
  // session that never declared one has no boundary to enforce. The execution
  // modes are what remain in that case.
  const context = ctx("", "out of scope: legacy.example.com");
  assert.deepEqual(scopeAllowlistFromContext(context), []);
  assert.equal(shellSafetyDetail("curl -s http://anything.test/x", context), undefined);
  assert.equal(
    browserActionSafetyDetail({ url: "http://anything.test/x", goal: "read" }, context),
    undefined,
  );
});
