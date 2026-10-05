import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpn-profiles-"));
process.env.KALI_DATA_DIR = tmp;

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const svc = require("../src/services/vpn-profiles.service") as typeof import("../src/services/vpn-profiles.service");

test("sanitizeProfileName strips unsafe characters and caps length", () => {
  assert.equal(svc.sanitizeProfileName("my vpn/corp"), "my_vpn_corp");
  assert.equal(svc.sanitizeProfileName("ok-name_1.2"), "ok-name_1.2");
  assert.ok(svc.sanitizeProfileName("x".repeat(200)).length <= 64);
});

test("saveProfile stores profile and assets, then deleteProfile removes both", () => {
  const stored = svc.saveProfile({
    originalName: "corp.ovpn",
    profileBuffer: Buffer.from("client\nremote example 1194\n"),
    assets: [{ originalname: "ca.crt", buffer: Buffer.from("PEM") }],
  });
  assert.ok("profile" in stored);
  if (!("profile" in stored)) return;

  const found = svc.findProfile("corp");
  assert.ok(found);
  assert.equal(found!.filename, "corp.ovpn");
  assert.ok(fs.existsSync(path.join(found!.assetDir, "ca.crt")));

  assert.equal(svc.deleteProfile("corp"), "deleted");
  assert.equal(svc.findProfile("corp"), undefined);
  assert.ok(!fs.existsSync(path.join(tmp, "vpn-profiles", "corp.files")));
});

test("interactive-auth profiles are detected", () => {
  const p = path.join(tmp, "probe.ovpn");
  fs.writeFileSync(p, "client\nauth-user-pass # prompt\n");
  assert.equal(svc.requiresInteractiveAuth(p), true);
});

test("saveProfile rejects duplicate asset names and rolls back", () => {
  const stored = svc.saveProfile({
    originalName: "dup.ovpn",
    profileBuffer: Buffer.from("x"),
    assets: [
      { originalname: "a.crt", buffer: Buffer.from("1") },
      { originalname: "a.crt", buffer: Buffer.from("2") },
    ],
  });
  assert.ok("error" in stored);
  assert.equal(svc.findProfile("dup"), undefined);
});

test("requiresInteractiveAuth flags auth-user-pass directives", () => {
  const p = path.join(tmp, "interactive.ovpn");
  fs.writeFileSync(p, "client\nauth-user-pass\n");
  assert.equal(svc.requiresInteractiveAuth(p), true);
  fs.writeFileSync(p, "client\nauth-nocache\n");
  assert.equal(svc.requiresInteractiveAuth(p), false);
});
