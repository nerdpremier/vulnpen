import assert from "node:assert/strict";
import test from "node:test";
import {
  scopeAllowlistFromContext,
  shellSafetyDetail,
} from "../src/utils/consentDetail";
import { EngagementState } from "../src/services/engagement-state";

// Mirrors engagementStateFromSession: the Target arms the gate, the joined free text
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

test("the attack box is not a boundary — only the target is", () => {
  // The box is disposable test infrastructure the tester owns and can rebuild,
  // so wiping it costs a rebuild, not harm to anyone. The engagement boundary is
  // the client system alone.
  for (const command of [
    "rm --recursive --force /",
    "sudo rm -rf /etc",
    "dd if=/dev/zero of=/dev/sda",
    "bash -c 'rm -rf /'",
  ]) {
    assert.equal(shellSafetyDetail(command, ctx("juice-shop:3000")), undefined, command);
  }
});

test("a destructive target action outranks every other verdict", () => {
  const detail = shellSafetyDetail(
    "sudo rm -rf / && curl -X DELETE http://juice-shop:3000/api/Users/1",
    ctx("juice-shop:3000"),
  );
  assert.equal(detail?.kind, "destructive_target");
});

test("a proxy flag names the fence, not a host the command connects to", () => {
  // The scan recipe sets P="-x http://egress:3128" and curls through it. The
  // proxy is the attack box's way out — `egress` is infrastructure, not a
  // destination the command itself connects to — so naming it in a -x/--proxy
  // flag must not surface an out_of_scope consent prompt.
  const withProxy = (proxyFlag: string) =>
    `P="${proxyFlag}"; B="http://zero.webappsecurity.com:8080"; curl -s -D - -o /dev/null --max-time 20 $P "$B/"`;

  for (const flag of [
    "-x http://egress:3128",
    "--proxy http://egress:3128",
    "--proxy=http://egress:3128",
    "-x http://127.0.0.1:3128",
  ]) {
    assert.equal(
      shellSafetyDetail(withProxy(flag), ctx("zero.webappsecurity.com:8080")),
      undefined,
      flag,
    );
  }
});

test("a proxy flag does not hide a real out-of-scope destination", () => {
  const base = 'P="-x http://egress:3128"; B="http://zero.webappsecurity.com:8080"; ';
  // The `egress` proxy flag is infrastructure, but the URL the command actually
  // hits still has to be judged: a write through the fence to a third party is
  // still a write to a third party, and an attack tool aimed at a third party
  // does not become engagement activity because the request egresses through
  // the fence.
  const write = base + 'curl -s -X POST -d "user=admin" $P "http://evil.example.net/login"';
  assert.equal(
    shellSafetyDetail(write, ctx("zero.webappsecurity.com:8080"))?.kind,
    "out_of_scope",
  );
});
