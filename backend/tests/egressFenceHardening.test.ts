import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { allowlistFromTarget, decideEgressRequest } from "../src/utils/egressPolicy";
import { detectDestructiveTargetAction, hasDeleteEndpoint } from "../src/utils/targetSafety";
import { createEgressProxy } from "../src/egressProxy";

const ALLOWLIST = allowlistFromTarget("juice-shop:3000");
const inScope = (request: Parameters<typeof decideEgressRequest>[0]) =>
  decideEgressRequest({ host: "juice-shop", ...request }, ALLOWLIST);

test("a method override in a header is judged, not only one in the request line", () => {
  for (const name of ["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"]) {
    const decision = inScope({
      method: "POST",
      url: "/api/Users/1",
      headers: { [name]: "DELETE" },
    });
    assert.equal(decision.allow, false, name);
  }
});

test("a method that is not in the permitted set never leaves", () => {
  for (const method of ["MOVE", "COPY", "MKCOL", "PROPPATCH", "LOCK", "PURGE", "UNLINK", "FOO"]) {
    for (const host of ["juice-shop", "deb.debian.org"]) {
      const decision = decideEgressRequest({ method, url: "/x", host }, ALLOWLIST);
      assert.equal(decision.allow, false, `${method} ${host}`);
      assert.equal(decision.allow === false && decision.rule, "egress:method", `${method} ${host}`);
    }
  }
});

test("encoding does not hide a statement from the rules", () => {
  for (const [url, body] of [
    ["/api/query", "q=DELETE%20FROM%20users"],
    ["/api/query", "q=DELETE+FROM+users"],
    ["/api/query", "q=DELETE%2520FROM%2520users"],
    ["/api/query", '{"q":"\\u0044ELETE FROM users"}'],
    ["/api/Users/1/%64elete", ""],
    ["/api/Users/1/%2564elete", ""],
    ["/api/Users/1?_method=%44ELETE", ""],
  ] as const) {
    const decision = inScope({ method: "POST", url, body });
    assert.equal(decision.allow, false, `${url} ${body}`);
  }
});

test("a GET that is a removal operation does not leave the engagement", () => {
  for (const url of [
    "/admin/delete?id=3",
    "/rest/user/deleteAccount",
    "/api/delete_user/3",
    "/api/user-remove/3",
    "/api/Users?action=remove&id=3",
  ]) {
    assert.equal(inScope({ method: "GET", url }).allow, false, url);
  }
});

test("reading a public page is not a removal just because its path says so", () => {
  const decision = decideEgressRequest(
    { method: "GET", url: "/scripts/remove-comments.js", host: "cdn.example-cdn.com" },
    ALLOWLIST,
  );
  assert.equal(decision.allow, true);
});

test("state and field names are not operations", () => {
  for (const text of [
    "/api/Users?deleted=false",
    "/api/Orders?status=removed",
    "/api/Products/undelete-policy",
    "/api/Users/1/avatar",
  ]) {
    assert.equal(hasDeleteEndpoint(text), false, text);
  }
  for (const text of ["/deleteUser", "/delete_user", "/user-delete", "/userDelete", "?x=remove"]) {
    assert.equal(hasDeleteEndpoint(text), true, text);
  }
});

test("a GraphQL mutation that removes something is a destructive action", () => {
  for (const text of [
    '{"query":"mutation { deleteUser(id: 1) { id } }"}',
    'curl http://t/graphql -d \'{"query":"mutation Clean { a: removeProduct(id:2) }"}\'',
  ]) {
    assert.equal(detectDestructiveTargetAction(text).dangerous, true, text);
  }
  const read = '{"query":"query { users { id deleted } }"}';
  assert.equal(detectDestructiveTargetAction(read).dangerous, false);
  const create = '{"query":"mutation { createUser(email: \\"a@b.c\\") { id } }"}';
  assert.equal(detectDestructiveTargetAction(create).dangerous, false);
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function send(
  proxyPort: number,
  options: { method: string; url: string; headers?: http.OutgoingHttpHeaders; body?: Buffer | string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const target = new URL(options.url);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: options.method,
        path: options.url,
        headers: { host: target.host, ...options.headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", (error) => resolve({ status: 0, body: String(error) }));
    req.end(options.body);
  });
}

test("on a real socket: a destructive statement past the old 8 KiB preview is still refused", async () => {
  let reached = 0;
  const upstream = http.createServer((_req, res) => {
    reached += 1;
    res.end("ok");
  });
  const upstreamPort = await listen(upstream);
  const proxy = createEgressProxy({ allowlist: ["127.0.0.1"] });
  const proxyPort = await listen(proxy);
  try {
    const padding = "a".repeat(20_000);
    const hidden = await send(proxyPort, {
      method: "POST",
      url: `http://127.0.0.1:${upstreamPort}/api/query`,
      body: `${padding} DELETE FROM users`,
    });
    assert.equal(hidden.status, 403, hidden.body);
    assert.equal(reached, 0);

    const echoed = await send(proxyPort, {
      method: "POST",
      url: `http://127.0.0.1:${upstreamPort}/api/echo`,
      body: padding,
    });
    assert.equal(echoed.status, 200, echoed.body);
    assert.equal(reached, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("on a real socket: what cannot be read in full does not leave", async () => {
  let reached = 0;
  const upstream = http.createServer((_req, res) => {
    reached += 1;
    res.end("ok");
  });
  const upstreamPort = await listen(upstream);
  const proxy = createEgressProxy({ allowlist: ["127.0.0.1"], maxBody: 1024 });
  const proxyPort = await listen(proxy);
  try {
    const url = `http://127.0.0.1:${upstreamPort}/api/upload`;
    const big = await send(proxyPort, { method: "POST", url, body: "a".repeat(4096) });
    assert.equal(big.status, 413, big.body);

    const packed = await send(proxyPort, {
      method: "POST",
      url,
      headers: { "content-encoding": "gzip" },
      body: "not really gzip",
    });
    assert.equal(packed.status, 415, packed.body);

    const tls = await send(proxyPort, { method: "GET", url: `https://127.0.0.1:${upstreamPort}/` });
    assert.equal(tls.status, 400, tls.body);

    const verb = await send(proxyPort, { method: "PURGE", url });
    assert.equal(verb.status, 403, verb.body);

    const override = await send(proxyPort, {
      method: "POST",
      url,
      headers: { "x-http-method-override": "DELETE" },
    });
    assert.equal(override.status, 403, override.body);

    assert.equal(reached, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("on a real socket: the request is forwarded to the judged host and port", async () => {
  let seenHost = "";
  const upstream = http.createServer((req, res) => {
    seenHost = String(req.headers.host);
    res.end("ok");
  });
  const upstreamPort = await listen(upstream);
  const proxy = createEgressProxy({ allowlist: ["127.0.0.1"] });
  const proxyPort = await listen(proxy);
  try {
    const reply = await send(proxyPort, {
      method: "GET",
      url: `http://127.0.0.1:${upstreamPort}/ok`,
      headers: { host: "somewhere-else.example", "proxy-connection": "keep-alive" },
    });
    assert.equal(reply.status, 200, reply.body);
    assert.equal(seenHost, `127.0.0.1:${upstreamPort}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});
