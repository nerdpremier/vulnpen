import { test } from "node:test";
import assert from "node:assert/strict";
import {
  novncFrameSrc,
  resolveNovncBase,
} from "./novncView.mjs";

/* ── Which desktop the frame points at ───────────────────────────────── */

test("an API-supplied address wins over the backend's own origin", () => {
  // The agent's browser runs on the attack box, whose desktop is a different
  // VNC stack on a different port. That answer has to beat the fallback.
  assert.equal(
    resolveNovncBase({
      novncUrl: "http://localhost:9020",
      novncPort: "6080",
      backendUrl: "http://localhost:8080",
    }),
    "http://localhost:9020",
  );
});

test("a bare host:port gets a scheme", () => {
  assert.equal(
    resolveNovncBase({ novncUrl: "kali:9020" }),
    "http://kali:9020",
  );
  assert.equal(
    resolveNovncBase({ novncUrl: "https://vnc.example.test/novnc" }),
    "https://vnc.example.test/novnc",
  );
});

test("a blank address falls back instead of producing a broken URL", () => {
  assert.equal(
    resolveNovncBase({
      novncUrl: "   ",
      novncPort: "6080",
      backendUrl: "http://localhost:8080",
    }),
    "http://localhost:6080",
  );
});

test("the fallback follows the app's host, not a hard-coded localhost", () => {
  // The noVNC port is published beside the API's, so an operator who reached
  // the app on another host has to be sent to that host too.
  assert.equal(
    resolveNovncBase({
      novncUrl: "",
      novncPort: "6080",
      backendUrl: "https://vulnpen.internal.test:8080",
    }),
    "https://vulnpen.internal.test:6080",
  );
});

test("an unparseable backend URL degrades to localhost rather than throwing", () => {
  assert.equal(
    resolveNovncBase({ novncPort: "6080", backendUrl: "not a url" }),
    "http://localhost:6080",
  );
  assert.equal(
    resolveNovncBase({ novncPort: "6080", backendUrl: undefined }),
    "http://localhost:6080",
  );
});

test("nothing to embed is null, not an empty frame", () => {
  assert.equal(resolveNovncBase({}), null);
  assert.equal(resolveNovncBase({ novncUrl: "", novncPort: "" }), null);
  assert.equal(resolveNovncBase(), null);
});

/* ── What the frame has to carry ─────────────────────────────────────── */

test("the frame carries the password the desktop asks for", () => {
  // Without it the desktop's noVNC page stops at "Authentication required",
  // which reads as a broken panel rather than a missing parameter.
  const src = novncFrameSrc("http://localhost:9020", "f9543356");
  assert.equal(
    src,
    "http://localhost:9020/vnc.html?password=f9543356&resize=scale&autoconnect=true",
  );
});

test("a password is percent-encoded, including characters form-encoding mangles", () => {
  const src = novncFrameSrc("http://localhost:9020", "a+b c&d=1");
  const password = new URL(src).searchParams.get("password");
  // `new URL` decodes with decodeURIComponent, which is what noVNC uses; a
  // literal "+" from form-encoding would come back as a space here.
  assert.equal(password, "a+b c&d=1");
  assert.ok(!src.includes("a+b"));
});

test("a desktop with no password still gets a usable frame", () => {
  const src = novncFrameSrc("http://localhost:6080", "");
  assert.equal(src, "http://localhost:6080/vnc.html?resize=scale&autoconnect=true");
  assert.ok(!src.includes("password"));
});

test("no base means no frame", () => {
  assert.equal(novncFrameSrc(null, "secret"), null);
  assert.equal(novncFrameSrc("", "secret"), null);
});
