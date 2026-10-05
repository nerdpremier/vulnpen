import assert from "node:assert/strict";
import test from "node:test";
import {
  detectDestructiveBrowserGoal,
  detectDestructiveTargetAction,
} from "../src/utils/targetSafety";
import {
  browserActionSafetyDetail,
  rawRequestSafetyDetail,
  shellSafetyDetail,
} from "../src/utils/consentDetail";
import { EngagementState } from "../src/services/engagement-state";

// Mirrors engagementStateFromSession: the Target arms the gate, the joined free text
// is what the gate parses into the allowlist.
function ctx(declaredTarget: string, scopeText = "") {
  const state = new EngagementState();
  state.declaredTarget = declaredTarget;
  state.scope = [declaredTarget, scopeText].filter(Boolean).join(" ");
  return { engagementState: state } as any;
}

const DESTRUCTIVE = [
  // HTTP DELETE, the exact action this boundary exists for.
  "curl -s -X DELETE https://target.example/api/users/7 -H 'Authorization: Bearer x'",
  "curl -XDELETE http://juice-shop:3000/api/Users/7",
  'curl --request "DELETE" http://juice-shop:3000/api/Orders/42',
  // Destructive verbs inside a Python exploit.
  'requests.delete(f"{base}/api/orders/{oid}")',
  'session.delete("https://target.example/api/users/me")',
  // Endpoints whose whole job is to remove or disable.
  "curl -s -X POST http://juice-shop:3000/api/Users/7/delete",
  "curl -s -X POST 'http://juice-shop:3000/api/orders/42?action=delete'",
  // Method override, the WSTG-CONF-06 trick that turns a safe verb into a wipe.
  "curl -X POST -H 'X-HTTP-Method-Override: DELETE' http://juice-shop:3000/api/orders/42",
  // Overwriting an existing object.
  "curl -X PUT http://juice-shop:3000/api/orders/42 -d '{\"status\":\"shipped\"}'",
  'requests.patch("https://target.example/api/orders/42", json={"role": "admin"})',
  // Destructive SQL through a client instead of the application.
  "mysql -h target.example -e \"UPDATE users SET role='admin' WHERE id=1\"",
  "mysql -h target.example -e 'DROP TABLE orders'",
  "mysql -h target.example -e 'TRUNCATE TABLE audit_log'",
  "mysql -h target.example -e 'DELETE FROM orders WHERE 1=1'",
  // Tool flags that hand over a shell or a write primitive on the target.
  "sqlmap -u http://juice-shop:3000/rest/products?id=1 --batch --os-shell",
  "sqlmap -u http://juice-shop:3000/rest/products?id=1 --file-write=./x.php --file-dest=/var/www/x.php",
  // A raw HTTP request sent through Burp Repeater.
  "DELETE /api/Users/7 HTTP/1.1\r\nHost: juice-shop:3000\r\nAuthorization: Bearer x\r\n\r\n",
  "POST /api/Users/7/delete HTTP/1.1\r\nHost: juice-shop:3000\r\n\r\n",
];

test("destructive actions against the target are detected", () => {
  for (const text of DESTRUCTIVE) {
    const result = detectDestructiveTargetAction(text);
    assert.equal(result.dangerous, true, text);
    assert.ok(result.rule.length > 0, text);
    assert.ok(result.reason.length > 0, text);
    assert.ok(result.impact.length > 0, text);
  }
});

const SAFE = [
  // Reading and reconnaissance.
  "curl -s http://juice-shop:3000/rest/products/search?q=test",
  "curl -s http://juice-shop:3000/api/Orders/42 -H 'Authorization: Bearer x'",
  'requests.get(f"{base}/api/orders/{oid}")',
  "nmap -sV juice-shop",
  "sqlmap -u 'http://juice-shop:3000/rest/products/search?q=1' --batch --dbs",
  "GET /api/Users/7 HTTP/1.1\r\nHost: juice-shop:3000\r\n\r\n",
  // Reaching a delete endpoint without issuing the delete verb: the proof the
  // rules of engagement ask for.
  "curl -s -X GET http://juice-shop:3000/api/Orders/42/delete",
  // Creating a test object is allowed; only destroying an existing one is not.
  'curl -s -X POST http://juice-shop:3000/api/Users -d \'{"email":"probe@test.local"}\'',
  "mysql -h target.example -e 'INSERT INTO probe_orders (id) VALUES (9999)'",
  // Ordinary writes with no destructive shape.
  "curl -s -X POST http://juice-shop:3000/rest/user/login -d 'email=a@b.c&password=x'",
  "echo 'update the set of findings in the report'",
  "gzip -d loot/orders.sql.gz",
];

test("reads, creates and bounded writes stay outside the boundary", () => {
  for (const text of SAFE) {
    assert.equal(detectDestructiveTargetAction(text).dangerous, false, text);
  }
});

test("a browser goal that asks for a destructive outcome is detected", () => {
  for (const goal of [
    "Delete the admin account from the user management page",
    "Remove the product with id 1 and confirm it is gone",
    "Disable the two-factor requirement for the admin user",
    "Reset the password of the administrator and sign in as them",
  ]) {
    assert.equal(detectDestructiveBrowserGoal(goal).dangerous, true, goal);
  }
});

test("a browser goal that explicitly rules the destructive step out is allowed", () => {
  for (const goal of [
    "Check whether the Delete button is reachable for a standard user without deleting anything",
    "Do not delete any record; confirm the delete control is hidden from a standard user",
    "Log in as the standard user and open the user management page",
    "Extract all usernames and email addresses from the table",
  ]) {
    assert.equal(detectDestructiveBrowserGoal(goal).dangerous, false, goal);
  }
});

test("an in-scope delete is a destructive target action, not merely in-scope", () => {
  const context = ctx("juice-shop:3000");
  // The finding this system exists to stop: an agent that is inside scope and
  // can delete an admin account must be stopped at the proof.
  const detail = shellSafetyDetail(
    "curl -s -X DELETE http://juice-shop:3000/api/Users/7",
    context,
  );
  assert.equal(detail?.kind, "destructive_target");
  assert.match(detail?.impact ?? "", /PoC/);
  assert.equal(
    shellSafetyDetail("curl -s http://juice-shop:3000/api/Users/7", context),
    undefined,
  );
});

test("a raw HTTP request through Burp is checked for the destructive verb", () => {
  const context = ctx("juice-shop:3000");
  const deleteRequest = rawRequestSafetyDetail(
    { host: "juice-shop", raw_request: "DELETE /api/Users/7 HTTP/1.1\r\nHost: juice-shop:3000\r\n\r\n" },
    context,
  );
  assert.equal(deleteRequest?.kind, "destructive_target");
  assert.equal(
    rawRequestSafetyDetail(
      { host: "juice-shop", raw_request: "GET /api/Users/7 HTTP/1.1\r\nHost: juice-shop:3000\r\n\r\n" },
      context,
    ),
    undefined,
  );
});

test("the raw HTTP host is held to the declared engagement", () => {
  const context = ctx("juice-shop:3000");
  const detail = rawRequestSafetyDetail(
    { host: "third-party.example.net", raw_request: "GET / HTTP/1.1\r\nHost: third-party.example.net\r\n\r\n" },
    context,
  );
  assert.equal(detail?.kind, "out_of_scope");
});

test("the browser boundary covers both intent and host", () => {
  const context = ctx("juice-shop:3000");
  assert.equal(
    browserActionSafetyDetail(
      { url: "http://juice-shop:3000/#/administration", goal: "Delete the admin user" },
      context,
    )?.kind,
    "destructive_target",
  );
  assert.equal(
    browserActionSafetyDetail(
      { url: "http://juice-shop:3000/#/administration", goal: "Open the user management page and list the users" },
      context,
    ),
    undefined,
  );
  assert.equal(
    browserActionSafetyDetail(
      { url: "https://third-party.example.net/admin", goal: "Open the admin page" },
      context,
    )?.kind,
    "out_of_scope",
  );
});