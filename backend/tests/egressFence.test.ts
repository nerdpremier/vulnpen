import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import {
  allowlistFromTarget,
  assertEgressProxyArmed,
  decideEgressRequest,
} from "../src/utils/egressPolicy";
import { createEgressProxy, egressAllowlist } from "../src/egressProxy";
import { createLeafSigner, loadOrCreateCa } from "../src/utils/egressCa";

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
let EMPTY_ALLOWLIST: string[] = [];

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

test("a POST from a real browser is not blocked by its own User-Agent", () => {
  // Chrome's User-Agent Reduction policy freezes the version to `<major>.0.0.0`
  // — "Chrome/150.0.0.0" is the literal value a current Chromium sends on every
  // request. That string is indistinguishable from a dotted IPv4 literal to a
  // regex, and a login POST is not a READ_METHODS member, so the public-read
  // exemption that covers GET never applied: the fence was flagging its own
  // client's version number as an out-of-scope host and dropping every write a
  // real browser made.
  const headers = {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="150", "Not=A?Brand";v="99"',
    "sec-ch-ua-full-version-list": '"Chromium";v="150.0.7871.181", "Not=A?Brand";v="99.0.0.0"',
  };
  const decision = decideEgressRequest(
    {
      method: "POST",
      url: "/signin.html",
      host: "juice-shop",
      body: "login=username&password=password",
      headers,
    },
    ALLOWLIST,
  );
  assert.equal(decision.allow, true);
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

// ---------------------------------------------------------------------------
// TLS interception: with EGRESS_ALLOW_TLS=1 the fence terminates CONNECT and
// runs the request inside it through the same rules as plain HTTP.
// ---------------------------------------------------------------------------

// node-forge generates RSA keys in pure JS, which is seconds per key. One CA and
// one upstream are shared across every TLS case below so the suite does not pay
// that cost six times over.
let tlsFixture: {
  caDir: string;
  caCert: Buffer;
  upstreamPort: number;
  closeUpstream: () => Promise<void>;
} | null = null;

async function tlsFixtureOnce() {
  if (tlsFixture) return tlsFixture;
  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-tls-"));
  // Materialise the fence's CA up front: the proxy creates it lazily, but the
  // test has to read ca.crt itself. Mirrors the egress process warming the CA at
  // boot when EGRESS_ALLOW_TLS=1.
  const ca = loadOrCreateCa(caDir);
  const caCert = fs.readFileSync(path.join(caDir, "ca.crt"));

  // An HTTPS upstream whose cert chains to that same CA, so the proxy's
  // outbound TLS leg validates it against `upstreamCa` (in production, the
  // system trust store).
  const leaf = createLeafSigner(ca)("127.0.0.1");
  const upstream = https.createServer({ cert: leaf.cert, key: leaf.key }, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = `tls-upstream-ok:${req.method}:${body}`;
      // A content-length, not chunked: the test reads the raw socket text and a
      // chunked body would need unwrapping.
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  const upstreamPort = await new Promise<number>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port));
  });

  tlsFixture = {
    caDir,
    caCert,
    upstreamPort,
    closeUpstream: () => new Promise((resolve) => upstream.close(() => resolve())),
  };
  return tlsFixture;
}

/**
 * Drive a GET/POST/… through the proxy inside a CONNECT tunnel, trusting the
 * fence's own CA on the client side — exactly what a tool on the attack box does
 * after `egress-ca-trust.service.ts` installs it. Resolves the HTTP status and
 * body, or a synthetic status 0 with the error text.
 */
function throughConnectTunnel(
  proxyPort: number,
  caCert: Buffer,
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const hostPort = target.port ? `${target.hostname}:${target.port}` : `${target.hostname}:443`;

  return new Promise((resolve) => {
    const connectReq = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: hostPort,
      headers: { host: hostPort },
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        resolve({ status: res.statusCode ?? 0, body: "connect-refused" });
        socket.destroy();
        return;
      }
      const secure = tls.connect(
        // `host` is what Node checks the presented certificate against when no
        // SNI name is set; an address literal goes here too, so the leaf's IP
        // SAN matches. No `servername` — an IP is not a legal SNI name.
        { socket, ca: caCert, host: target.hostname },
        () => {
          const lines = [
            `${method} ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.host}`,
            ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
            "Connection: close",
            "",
            body ?? "",
          ];
          secure.write(lines.join("\r\n"));
        },
      );
      let raw = "";
      secure.on("data", (chunk) => (raw += chunk.toString()));
      secure.on("end", () => {
        // "HTTP/1.1 200 OK" — the status is the token after the version.
        const status = Number(raw.split(" ")[1]) || 0;
        const split = raw.indexOf("\r\n\r\n");
        resolve({ status, body: split >= 0 ? raw.slice(split + 4) : raw });
      });
      secure.on("error", (error) => {
        socket.destroy();
        resolve({ status: 0, body: String(error) });
      });
    });
    connectReq.on("error", (error) => resolve({ status: 0, body: String(error) }));
    connectReq.end();
  });
}

/** A proxy wired to the shared CA, forwarding its HTTPS leg to the fixture. */
async function tlsProxy(allowlist: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  const fixture = await tlsFixtureOnce();
  const proxy = createEgressProxy({
    allowlist,
    allowTls: true,
    caDir: fixture.caDir,
    upstreamCa: fixture.caCert,
  });
  const port = await listen(proxy);
  // Force-close rather than wait: a CONNECT tunnel leaves a decrypted socket in
  // the http server's connection set, and server.close() would block on it.
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

test("with TLS interception on: an in-scope HTTPS read is forwarded and judged", async () => {
  const fixture = await tlsFixtureOnce();
  const proxy = await tlsProxy(["127.0.0.1"]);
  try {
    const read = await throughConnectTunnel(
      proxy.port,
      fixture.caCert,
      "GET",
      `https://127.0.0.1:${fixture.upstreamPort}/ok`,
    );
    assert.equal(read.status, 200, read.body);
    assert.equal(read.body, "tls-upstream-ok:GET:");

    // A destructive write inside the same tunnel is judged exactly like HTTP.
    const write = await throughConnectTunnel(
      proxy.port,
      fixture.caCert,
      "DELETE",
      `https://127.0.0.1:${fixture.upstreamPort}/api/Users/1`,
    );
    assert.equal(write.status, 403, write.body);
    assert.match(write.body, /blocked/);
  } finally {
    await proxy.close();
  }
});

test("with TLS interception on: a write to a public host is refused before any upstream", async () => {
  const fixture = await tlsFixtureOnce();
  const proxy = await tlsProxy(["juice-shop"]);
  try {
    // A public host that is nonetheless out of scope. The GET a search engine
    // needs is exempt (covered at the decision layer above); a write to it is
    // not, and the tunnel has to reach the same verdict plain HTTP does. The
    // block happens before the proxy dials anything, so this needs no network.
    const write = await throughConnectTunnel(
      proxy.port,
      fixture.caCert,
      "POST",
      "https://html.duckduckgo.com/html/",
      "x=1",
    );
    assert.equal(write.status, 403, write.body);
    assert.match(write.body, /out-of-scope/);
  } finally {
    await proxy.close();
  }
});

test("with TLS interception on: a private host's CONNECT is refused before any handshake", async () => {
  await tlsFixtureOnce();
  const proxy = await tlsProxy(["juice-shop"]);
  try {
    for (const authority of ["10.0.0.5:443", "erp.internal:443", "some-docker:443"]) {
      const status = await new Promise<number>((resolve) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxy.port,
          method: "CONNECT",
          path: authority,
        });
        req.on("connect", (res) => {
          resolve(res.statusCode ?? 0);
          res.socket?.destroy();
        });
        req.on("error", () => resolve(0));
        req.end();
      });
      assert.equal(status, 403, authority);
    }
  } finally {
    await proxy.close();
  }
});

test.after(async () => {
  if (tlsFixture) {
    await tlsFixture.closeUpstream();
    fs.rmSync(tlsFixture.caDir, { recursive: true, force: true });
    tlsFixture = null;
  }
});

// The public-read exemption is a decision, not a socket behaviour, so it is
// asserted where the rule lives — the same way the plain-HTTP cases above do.
test("an HTTPS read of a public out-of-scope host is exempt, exactly as over HTTP", () => {
  const decision = decideEgressRequest(
    { method: "GET", url: "/html/?q=test", host: "html.duckduckgo.com" },
    ALLOWLIST,
  );
  assert.equal(decision.allow, true);
});
