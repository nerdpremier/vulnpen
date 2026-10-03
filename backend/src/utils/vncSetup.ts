/**
 * Shell-command builders for configuring VNC on a remote exploit box over SSH.
 *
 * These are pure string builders (no SSH dependency) so the command shape can
 * be unit-tested and shared across the auto-setup / repair / connect flows.
 *
 * Debian's tigervnc packages ship no `vncpasswd`/`tigervncpasswd` binary (only
 * `Xtigervnc`, `vncserver`, `tigervncconfig`). Piping a password into a missing
 * binary leaves an empty `~/.vnc/passwd`, so Xvnc starts with `VncAuth` and an
 * empty password and rejects every client. To stay functional we probe for a
 * working password tool and fall back to `-SecurityTypes None` when none exists.
 * That is acceptable here because VNC access is restricted to the SSH tunnel and
 * loopback (websockify binds localhost).
 */

export const VNC_PASSWD_MARKER_OK = "HAVE_VNC_PASSWD";
export const VNC_PASSWD_MARKER_NONE = "NO_VNC_PASSWD";

/**
 * Writes `~/.vnc/passwd` in the standard VNC (d3des) format, then prints a
 * marker so the caller can pick the Xvnc security type.
 *
 * Tries password tools in order of preference and stops at the first that
 * works: `vncpasswd`/`tigervncpasswd` (when the distro ships them), then
 * `x11vnc -storepasswd`, which writes the identical format and is available
 * even on Debian tigervnc (which ships no vncpasswd). This keeps real VNC auth
 * enabled on every box we can write a passwd file for, instead of falling back
 * to no auth. `escapedPassword` must already be shell-single-quote escaped.
 */
export function writeVncPasswordCmd(escapedPassword: string): string {
  return (
    "mkdir -p ~/.vnc; " +
    `if PW_BIN="$(command -v vncpasswd || command -v tigervncpasswd)"; then ` +
    `echo '${escapedPassword}' | "$PW_BIN" -f > ~/.vnc/passwd 2>/dev/null; ` +
    "elif command -v x11vnc >/dev/null 2>&1; then " +
    `x11vnc -storepasswd '${escapedPassword}' ~/.vnc/passwd >/dev/null 2>&1; ` +
    "fi; " +
    "chmod 600 ~/.vnc/passwd 2>/dev/null; " +
    `[ -s ~/.vnc/passwd ] && echo ${VNC_PASSWD_MARKER_OK} || echo ${VNC_PASSWD_MARKER_NONE}`
  );
}

export function hasVncPassword(probeOutput: string): boolean {
  return probeOutput.includes(VNC_PASSWD_MARKER_OK);
}

/**
 * Security arguments for a direct `Xvnc`/`Xtigervnc` start. Uses password auth
 * when a password file was written, otherwise no auth (SSH-tunnel-only access).
 *
 * `-rfbauth` is deliberately the only password flag used: TightVNC's Xvnc
 * accepts it and TigerVNC documents it as an alias for `-PasswordFile`. The
 * TigerVNC-only spellings are not portable — the stock Kali image ships
 * TightVNC, whose Xvnc aborts with "Unrecognized option: -SecurityTypes" and
 * leaves noVNC serving a page with no RFB server behind it. `-SecurityTypes
 * None` stays for the no-password fallback, which TightVNC never reaches
 * because its package installs `vncpasswd`.
 */
export function xvncSecurityArgs(useVncAuth: boolean): string {
  return useVncAuth ? "-rfbauth ~/.vnc/passwd" : "-SecurityTypes None";
}

/**
 * True when `host` is a Docker-internal alias rather than something the
 * operator's browser can resolve. The noVNC iframe is loaded from the browser,
 * so a name such as "kali" - which only resolves inside the Compose network -
 * must be translated to the Docker host first. A localhost/loopback address, an
 * IPv4 literal, or any dotted host name is left to the browser.
 *
 * Shared by the one-click setup and the connect flow so the stored `VNC_HOST`
 * value and the URL returned to the UI can never disagree again.
 */
export function isDockerInternalHost(host: string): boolean {
  return (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
    !host.includes(".")
  );
}

/**
 * Installs a `policy-rc.d` that denies service starts so apt maintainer scripts
 * don't hang trying to start daemons inside a container with no init system.
 */
export const APT_POLICY_GUARD_INSTALL =
  "printf '#!/bin/sh\\nexit 101\\n' | sudo tee /usr/sbin/policy-rc.d >/dev/null 2>&1 && sudo chmod +x /usr/sbin/policy-rc.d || true";

export const APT_POLICY_GUARD_REMOVE =
  "sudo rm -f /usr/sbin/policy-rc.d 2>/dev/null || true";
