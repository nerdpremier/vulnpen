import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  allowlistFromTarget,
  assertEgressProxyArmed,
  decideEgressRequest,
} from "../src/utils/egressPolicy";
import { createEgressProxy, egressAllowlist } from "../src/egressProxy";

/**
 * The egress fence.
 *
 * These tests are the answer to "can a determined agent get a destructive
 * request past the boundary?". The rules are the same ones the text checks use —
 * what is under test is that they are applied to the *request*, at a point the
 * agent cannot route around, so none of the command-level evasion
 * (`sudo`, `bash -c`, `base64 | sh`, a script on disk) reaches them.
 */

const ALLOWLIST = allowlistFromTarget("juice-shop:3000");

test("a request to a host outside the engagement does not leave", () => {
  for (const host of ["evil.test", "10.9.9.9", "erp.internal"]) {
    const decision = decideEgressRequest({ method: "GET", url: "/", host }, ALLOWLIST);
    assert.equal(decision.allow, false, host);
    assert.equal(decision.allow === false && decision.rule, "egress:out-of-scope", host);
  }
});

test("reading the public internet passes — the box still has to work", () => {
  // The target is a real system on the public internet, so the fence cannot be a
  // blanket allowlist: tool downloads and OSINT lookups are reads, and blocking
  // them would break the engagement rather than protect anyone.
  for (const [method, host, url] of [
    ["GET", "api.shodan.io", "/shodan/host/1.2.3.4"],
    ["GET", "crt.sh", "/?q=example.com"],
    ["GET", "deb.debian.org", "/debian/pool/main/n/nmap/nmap_7.94.deb"],
    ["HEAD", "www.google.com", "/"],
    ["GET", "registry.npmjs.org", "/left-pad"],
  ] as const) {
    const decision = decideEgressRequest({ method, url, host }, ALLOWLIST);
    assert.equal(decision.allow, true, `${method} ${host}`);
  }
});

test("writing to a host outside the engagement does not leave", () => {
  for (const [method, host, url] of [
    ["POST", "pastebin.com", "/api/upload"],
    ["PUT", "somewhere-else.com", "/x"],
    ["DELETE", "third-party.example.net", "/api/1"],
    ["POST", "10.20.30.40", "/x"],
  ] as const) {
    const decision = decideEgressRequest({ method, url, host }, ALLOWLIST);
    assert.equal(decision.allow, false, `${method} ${host}`);
  }
});

test("a DELETE does not leave, whichever client sent it", () => {
  // The command that produced this request is irrelevant: curl, python, a
  // compiled binary and the browser all put these same bytes on the wire.
  const decision = decideEgressRequest(
    { method: "DELETE", url: "/api/Users/1", host: "juice-shop" },
    ALLOWLIST,
  );
  assert.equal(decision.allow, false);
  assert.match(decision.allow === false ? decision.rule : "", /delete/i);
});

test("a delete spelled as an ordinary POST does not leave either", () => {
  for (const [method, url, body] of [
    ["POST", "/api/Users/1/delete", ""],
    ["POST", "/rest/user/remove", ""],
    ["POST", "/api/Users/1", "_method=DELETE"],
    ["POST", "/api/Users/1", '{"method":"DELETE"}'],
    ["PUT", "/api/Products/1", ""],
    ["POST", "/api/query", "DELETE FROM users WHERE 1=1"],
    ["POST", "/api/query", "DEL/**/ETE FROM users"],
    ["POST", "/api/tool", "--os-shell"],
  ] as const) {
    const decision = decideEgressRequest({ method, url, host: "juice-shop", body }, ALLOWLIST);
    assert.equal(decision.allow, false, `${method} ${url} ${body}`);
  }
});

test("a host named inside an in-scope request is still out of scope", () => {
  // The destination would reach it on our behalf.
  const decision = decideEgressRequest(
    { method: "POST", url: "/api/fetch?url=http://evil.test/x", host: "juice-shop" },
    ALLOWLIST,
  );
  assert.equal(decision.allow, false);
});

test("overwriting an existing record is refused, however the request is written", () => {
  // `curl -X PUT http://t/api/Products/1` was already refused before the fence
  // existed. A raw request line has to reach the same verdict, or Repeater and
  // the browser become a way around a rule that curl obeys.
  for (const [method, url] of [
    ["PUT", "/api/Products/1"],
    ["PATCH", "/rest/basket/1"],
  ] as const) {
    const decision = decideEgressRequest({ method, url, host: "juice-shop" }, ALLOWLIST);
    assert.equal(decision.allow, false, `${method} ${url}`);
  }
});

test("ordinary testing traffic is not slowed down by the fence", () => {
  for (const [method, url, body] of [
    ["GET", "/rest/products/search?q=test", ""],
    ["POST", "/rest/user/login", '{"email":"a@b.c","password":"x"}'],
    ["POST", "/api/Users", '{"email":"a@b.c"}'],
    ["POST", "/rest/basket", '{"productId":1}'],
    ["GET", "/api/Products/1", ""],
    ["POST", "/api/Feedbacks", '{"comment":"nice"}'],
    ["GET", "/api/Users/1", ""],
  ] as const) {
    const decision = decideEgressRequest({ method, url, host: "juice-shop", body }, ALLOWLIST);
    assert.equal(decision.allow, true, `${method} ${url} ${body}`);
  }
});

test("an unarmed fence refuses to run instead of passing everything", () => {
  // The box is configured with no other route, so "serving unarmed" would be
  // strictly worse than not serving: it looks like a fence and is not one.
  assert.throws(() => assertEgressProxyArmed({ allowlist: [], port: 3128 }), /not armed/);
  assert.doesNotThrow(() => assertEgressProxyArmed({ allowlist: ALLOWLIST, port: 3128 }));
});

test("the allowlist can be given explicitly or derived from the Target", () => {
  assert.deepEqual(egressAllowlist({ EGRESS_ALLOWLIST: "a.test, b.test" } as any), ["a.test", "b.test"]);
  assert.ok(egressAllowlist({ EGRESS_TARGET: "juice-shop:3000" } as any).includes("juice-shop"));
});

// ---------------------------------------------------------------------------
// The fence as a process: the same decisions, made on a real socket.
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function throughProxy(
  proxyPort: number,
  method: string,
  absoluteUrl: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const url = new URL(absoluteUrl);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        path: absoluteUrl,
        headers: { host: url.host },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", (error) => resolve({ status: 0, body: String(error) }));
    req.end(body);
  });
}

test("on a real socket: allowed traffic is forwarded, everything else is refused", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  const upstreamPort = await listen(upstream);

  const proxy = createEgressProxy({ allowlist: ["127.0.0.1"], allowTls: false });
  const proxyPort = await listen(proxy);

  try {
    const allowed = await throughProxy(proxyPort, "GET", `http://127.0.0.1:${upstreamPort}/ok`);
    assert.equal(allowed.status, 200, allowed.body);
    assert.equal(allowed.body, "upstream-ok");

    const destructive = await throughProxy(
      proxyPort,
      "DELETE",
      `http://127.0.0.1:${upstreamPort}/api/Users/1`,
    );
    assert.equal(destructive.status, 403, destructive.body);
    assert.match(destructive.body, /blocked/);

    const sneaky = await throughProxy(
      proxyPort,
      "POST",
      `http://127.0.0.1:${upstreamPort}/api/Users/1/delete`,
    );
    assert.equal(sneaky.status, 403, sneaky.body);

    const outOfScope = await throughProxy(proxyPort, "GET", "http://evil.test/x");
    assert.equal(outOfScope.status, 403, outOfScope.body);
    assert.match(outOfScope.body, /out-of-scope/);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("on a real socket: an opaque TLS tunnel is refused by default", async () => {
  const proxy = createEgressProxy({ allowlist: ["juice-shop"], allowTls: false });
  const proxyPort = await listen(proxy);
  try {
    const status = await new Promise<number>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: "juice-shop:443",
      });
      req.on("connect", (res) => {
        resolve(res.statusCode ?? 0);
        res.socket?.destroy();
      });
      req.on("error", () => resolve(0));
      req.end();
    });
    assert.equal(status, 403, "a tunnel cannot be inspected, so it must not be opened");
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});
