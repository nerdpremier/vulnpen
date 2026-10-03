import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeVncPasswordCmd,
  hasVncPassword,
  xvncSecurityArgs,
  isDockerInternalHost,
  VNC_PASSWD_MARKER_OK,
  VNC_PASSWD_MARKER_NONE,
} from "../src/utils/vncSetup";

test("writeVncPasswordCmd tries vncpasswd, tigervncpasswd, then x11vnc", () => {
  const cmd = writeVncPasswordCmd("s3cret");
  assert.match(cmd, /command -v vncpasswd \|\| command -v tigervncpasswd/);
  assert.match(cmd, /echo 's3cret' \| "\$PW_BIN" -f > ~\/\.vnc\/passwd/);
  // x11vnc -storepasswd writes the same VNC format and exists on Debian tigervnc.
  assert.match(cmd, /x11vnc -storepasswd 's3cret' ~\/\.vnc\/passwd/);
  // `-s` check reports whether a non-empty passwd file was actually produced.
  assert.match(cmd, /\[ -s ~\/\.vnc\/passwd \]/);
  assert.ok(cmd.includes(VNC_PASSWD_MARKER_OK));
  assert.ok(cmd.includes(VNC_PASSWD_MARKER_NONE));
});

test("hasVncPassword parses the probe markers", () => {
  assert.equal(hasVncPassword(`\n${VNC_PASSWD_MARKER_OK}\n`), true);
  assert.equal(hasVncPassword(`\n${VNC_PASSWD_MARKER_NONE}\n`), false);
  assert.equal(hasVncPassword(""), false);
});

test("xvncSecurityArgs uses the cross-flavour -rfbauth flag when a password was set", () => {
  // -rfbauth works on both TightVNC's and TigerVNC's Xvnc; the TigerVNC-only
  // -SecurityTypes/-PasswordFile pair makes the Kali image's TightVNC abort.
  assert.equal(xvncSecurityArgs(true), "-rfbauth ~/.vnc/passwd");
  assert.equal(xvncSecurityArgs(false), "-SecurityTypes None");
});
test("isDockerInternalHost only flags names a browser cannot resolve", () => {
  // "kali" is the Compose-network alias the backend stores in VNC_HOST; the
  // iframe runs in the operator's browser and cannot resolve it.
  assert.equal(isDockerInternalHost("kali"), true);
  assert.equal(isDockerInternalHost("localhost"), false);
  assert.equal(isDockerInternalHost("127.0.0.1"), false);
  assert.equal(isDockerInternalHost("10.0.0.5"), false);
  assert.equal(isDockerInternalHost("box.example.com"), false);
});
