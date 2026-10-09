import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWordEditorUrl,
  collaboraPublicUrl,
  collaboraUrl,
  wopiPublicBase,
} from "../src/services/web-security/wopi.service";

const INTERNAL_URLSRC = "http://collabora:9980/browser/201368fc8d/cool.html?";

const discoveryXml = (urlSrc: string) =>
  `<wopi-discovery><net-zone name="external-http">` +
  `<app name="application/vnd.openxmlformats-officedocument.wordprocessingml.document">` +
  `<action default="true" ext="docx" name="edit" urlsrc="${urlSrc}"/>` +
  `</app></net-zone></wopi-discovery>`;

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => Promise<Response> | Response) {
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown) =>
    handler(String(url));
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

const savedEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
}

test("container discovery host never leaks into the browser iframe URL", async () => {
  process.env.COLLABORA_URL = "http://collabora:9980";
  process.env.COLLABORA_PUBLIC_URL = "http://localhost:9980";
  delete process.env.WOPI_PUBLIC_BASE;
  let fetched = "";
  stubFetch((url) => {
    fetched = url;
    return new Response(discoveryXml(INTERNAL_URLSRC), { status: 200 });
  });
  try {
    const editor = await buildWordEditorUrl("sess-1", "uid-1");
    assert.ok(
      fetched.startsWith("http://collabora:9980/hosting/discovery"),
      `discovery should use the container address, went to ${fetched}`,
    );
    const parsed = new URL(editor.url);
    assert.equal(parsed.host, "localhost:9980");
    assert.equal(
      parsed.searchParams.get("WOPISrc"),
      "http://host.docker.internal:8080/api/wopi/files/sess-1",
    );
    assert.ok((parsed.searchParams.get("access_token") ?? "").length >= 32);
    // The report is white paper: the editor must not follow the browser's
    // dark-mode preference (which turned chrome and page dark).
    assert.equal(parsed.searchParams.get("ui_theme"), "light");
    assert.equal(parsed.searchParams.get("background"), "ffffff");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("a refused Collabora connection names the service and the override", async () => {
  process.env.COLLABORA_URL = "http://localhost:9980";
  const refused = new TypeError("fetch failed");
  (refused as unknown as { cause: unknown }).cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:9980"),
    { code: "ECONNREFUSED" },
  );
  stubFetch(() => {
    throw refused;
  });
  try {
    await assert.rejects(
      buildWordEditorUrl("sess-1", "uid-1"),
      (err: unknown) => {
        assert.match(String((err as Error).message), /Collabora is unreachable/);
        assert.match(String((err as Error).message), /COLLABORA_URL/);
        return true;
      },
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("server-side discovery defaults to localhost, browser default stays host-local", () => {
  delete process.env.COLLABORA_URL;
  delete process.env.COLLABORA_PUBLIC_URL;
  delete process.env.WOPI_PUBLIC_BASE;
  try {
    assert.equal(collaboraUrl(), "http://localhost:9980");
    assert.equal(collaboraPublicUrl(), "http://localhost:9980");
    assert.equal(
      wopiPublicBase(),
      "http://host.docker.internal:8080/api/wopi/files",
    );
  } finally {
    restoreEnv();
  }
});
