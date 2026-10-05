import { Response, Request } from "express";
import { readEnvFile } from "../utils/envWriter";
import { getVncDisplay, getVncRfbPort, getWebsockifyPort } from "../config/constants";
import { requireActiveSession } from "../services/session.helpers";
import { execOnWorkHost, resolveSessionWorkHost } from "../services/work-host.service";
import {
  writeVncPasswordCmd,
  hasVncPassword,
  xvncSecurityArgs,
  isDockerInternalHost,
} from "../utils/vncSetup";
import {
  getVncConfig,
  updateVncConfig,
  resetVncConfig,
  provisionVnc,
  runDiagnostics,
  repairVnc as repairVncSession,
} from "../services/vnc-provisioning.service";

const FIND_VNC_BIN = [
  'export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/libexec";',
  'for b in Xvnc Xtigervnc vncserver tigervncserver x11vnc; do',
  '  p="$(command -v "$b" 2>/dev/null)" && [ -x "$p" ] && echo "$p" && exit 0;',
  'done;',
  'for p in /usr/bin/Xvnc /usr/bin/Xtigervnc /usr/bin/vncserver /usr/bin/tigervncserver /usr/bin/x11vnc; do',
  '  [ -x "$p" ] && echo "$p" && exit 0;',
  'done;',
  'echo ""',
].join(' ');

function pickVncPath(raw: string): string {
  for (const line of raw.trim().split("\n")) {
    const t = line.trim();
    if (t.startsWith("/") && !t.includes(" ")) return t;
  }
  return "";
}

export const getVNCCredentials = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { session_id: sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ message: "Invalid session id" });
    }
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const VNC_DISPLAY = getVncDisplay();
    const VNC_RFBPORT = getVncRfbPort();
    const WEBSOCKIFY_PORT = getWebsockifyPort();
    const env = readEnvFile();
    const vncMode = env.VNC_MODE || "";
    const savedHost = env.VNC_HOST || "";
    const savedPort = env.VNC_PORT || "9020";
    const savedPassword = env.VNC_PASSWORD || "";
    const setupDone = env.VNC_SETUP_DONE === "true";
    const baseUrlOverride = (env.VNC_BASE_URL || "").trim();

    const defaultVncURL = savedPort ? `${savedHost}:${savedPort}` : savedHost;

    if (vncMode === "manual" && savedHost && savedPassword) {
      return res.status(200).json({
        vncURL: baseUrlOverride || defaultVncURL,
        password: savedPassword,
      });
    }

    if (vncMode === "auto" && setupDone && savedHost && savedPassword) {
      try {
            const target = await resolveSessionWorkHost(sessionId);
            const exec = async (cmd: string) => {
              const result = await execOnWorkHost(sessionId, cmd, 120_000);
              if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Command failed (${result.code})`);
            };
            const execWithOutput = async (cmd: string) => {
              const result = await execOnWorkHost(sessionId, cmd, 120_000);
              return `${result.stdout}${result.stderr}`;
            };

            // Detect which VNC binary is available
            const vncRaw = await execWithOutput(FIND_VNC_BIN);
            const vncBin = pickVncPath(vncRaw) || "Xvnc";
            const isXvncDirect = vncBin.endsWith("Xvnc") || vncBin.endsWith("Xtigervnc");
            const isX11vnc = vncBin.endsWith("x11vnc");

            // Ensure xstartup exists with DISPLAY export
            await exec(
              `mkdir -p ~/.vnc && printf '#!/bin/bash\\nexport DISPLAY=${VNC_DISPLAY}\\n[ -f $HOME/.Xresources ] && xrdb $HOME/.Xresources\\nif command -v startxfce4 >/dev/null 2>&1; then\\n  startxfce4 &\\nelif command -v openbox-session >/dev/null 2>&1; then\\n  openbox-session &\\nelse\\n  xterm &\\nfi\\n' > ~/.vnc/xstartup && chmod +x ~/.vnc/xstartup`
            );

            // Reuse a live desktop: probing the RFB port first keeps the
            // running session (and its apps) intact when the GUI page
            // remounts and re-calls this endpoint.
            const portProbe = (port: number) =>
              execWithOutput(
                `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${port} " && echo UP || echo DOWN`
              );
            const rfbState = (await portProbe(VNC_RFBPORT)).trim();

            if (rfbState === "UP") {
              const wsState = (await portProbe(WEBSOCKIFY_PORT)).trim();
              if (wsState !== "UP") {
                await exec(
                  `websockify --web /usr/share/novnc/ ${WEBSOCKIFY_PORT} localhost:${VNC_RFBPORT} > /dev/null 2>&1 < /dev/null &`
                );
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
              const runtimeHost = isDockerInternalHost(savedHost)
                ? "localhost"
                : savedHost;
              const vncURL = baseUrlOverride || `${runtimeHost}:${savedPort}`;
              console.log(
                `[connect-vnc] session ${sessionId} -> ${vncURL} (reused live desktop)`
              );
              return res.status(200).json({
                vncURL,
                password: savedPassword,
                workHost: target.kind,
              });
            }

            // Kill all existing VNC/Xvfb for a clean start
            await exec(
              `vncserver -kill "${VNC_DISPLAY}" 2>/dev/null || true; ` +
              `pkill -f '[x]11vnc.*-display ${VNC_DISPLAY}.*-rfbport ${VNC_RFBPORT}' 2>/dev/null || true; ` +
              `pkill -f '[X]vfb ${VNC_DISPLAY}' 2>/dev/null || true; ` +
              `pkill -f '[X](vnc|tigervnc).*${VNC_DISPLAY}.*rfbport ${VNC_RFBPORT}' 2>/dev/null || true`
            );

            // Set password. Fall back to no VNC auth when the box has no working
            // vncpasswd binary (e.g. Debian tigervnc) so the server still starts;
            // access stays restricted to the SSH tunnel + loopback. The passwd
            // file is written for every path so x11vnc can use -rfbauth instead
            // of -passwd (which would leak the password via the process list).
            const escapedPassword = savedPassword.replace(/'/g, "'\\''");
            let useVncAuth = false;
            {
              const pwProbe = await execWithOutput(
                writeVncPasswordCmd(escapedPassword)
              );
              useVncAuth = hasVncPassword(pwProbe);
            }

            // Start VNC based on detected binary. Backgrounded processes MUST
            // also redirect stdin (< /dev/null): sshd keeps the exec channel
            // open while the child holds any inherited fd, so a long-lived
            // Xvnc/websockify without stdin redirection hangs the SSH exec
            // until the 120s timeout even though the command itself succeeded.
            if (isXvncDirect) {
              await exec(
                `${vncBin} ${VNC_DISPLAY} -geometry 1280x800 -depth 24 -rfbport ${VNC_RFBPORT} ` +
                `${xvncSecurityArgs(useVncAuth)} ` +
                `-pn > /dev/null 2>&1 < /dev/null &`
              );
              await new Promise((r) => setTimeout(r, 1500));
              await exec(`export DISPLAY=${VNC_DISPLAY} && ~/.vnc/xstartup > /dev/null 2>&1 < /dev/null &`);
            } else if (isX11vnc) {
              await exec(
                "command -v Xvfb >/dev/null 2>&1 || (export DEBIAN_FRONTEND=noninteractive && sudo apt-get install -y -qq xvfb 2>&1 || true)"
              );
              await exec(`Xvfb ${VNC_DISPLAY} -screen 0 1280x800x24 > /dev/null 2>&1 < /dev/null &`);
              await new Promise((r) => setTimeout(r, 2000));
              await exec(`export DISPLAY=${VNC_DISPLAY} && ~/.vnc/xstartup > /dev/null 2>&1 < /dev/null &`);
              await exec(
                `x11vnc -display ${VNC_DISPLAY} -rfbport ${VNC_RFBPORT} ` +
                (useVncAuth
                  ? "-rfbauth ~/.vnc/passwd "
                  : "") +
                "-forever -shared -noxdamage > /dev/null 2>&1 < /dev/null &"
              );
              await new Promise((r) => setTimeout(r, 1500));
            } else {
              await exec(`${vncBin} -geometry 1280x800 -depth 24 ${VNC_DISPLAY}`);
            }

            // Start websockify. The bracket keeps pkill's own command line from
            // matching the pattern — a plain 'websockify.*PORT' matches the
            // shell executing this very command, kills it, and the SSH exec
            // hangs until timeout.
            await exec(`pkill -f '[w]ebsockify.*${WEBSOCKIFY_PORT}' 2>/dev/null || true`);
            await exec(
              `websockify --web /usr/share/novnc/ ${WEBSOCKIFY_PORT} localhost:${VNC_RFBPORT} > /dev/null 2>&1 < /dev/null &`
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));

            // The noVNC iframe is loaded by the OPERATOR'S BROWSER, so the URL
            // must be resolvable from there. A saved host such as "kali" is a
            // Docker-internal alias no browser can resolve, so it maps to
            // localhost - where websockify is published in this deployment.
            const runtimeHost = isDockerInternalHost(savedHost)
              ? "localhost"
              : savedHost;
            const vncURL = baseUrlOverride || `${runtimeHost}:${savedPort}`;
            console.log(`[connect-vnc] session ${sessionId} -> ${vncURL}`);
            return res.status(200).json({
              vncURL,
              password: savedPassword,
              workHost: target.kind,
            });
          } catch (error: any) {
            const msg = error?.message || String(error);
            console.error("VNC start error:", msg);
            return res.status(400).json({
              message: `Failed to start VNC session: ${msg}`,
            });
          }
    }

    return res.status(400).json({
      message: "VNC not configured. Please set up VNC from Settings > GUI.",
      notConfigured: true,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get VNC credentials" });
  }
};


export const getVNCConfig = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(getVncConfig());
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get VNC config" });
  }
};

export const updateVNCConfig = async (req: Request, res: Response) => {
  try {
    updateVncConfig(req.body || {});
    return res.status(200).json({ message: "VNC configuration saved" });
  } catch (error: any) {
    console.log(error);
    return res.status(400).json({
      message: error?.message || "Failed to update VNC config",
    });
  }
};

export const resetVNCConfig = async (_req: Request, res: Response) => {
  try {
    resetVncConfig();
    return res.status(200).json({ message: "VNC configuration reset" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to reset VNC config" });
  }
};

export const autoSetupVNC = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    const session = await requireActiveSession(res.locals.userId, sessionId, res);
    if (!session) return;
    const result = await provisionVnc(sessionId);
    return res.status(200).json(result);
  } catch (error: any) {
    console.log(error);
    return res.status(400).json({
      message:
        error?.message ||
        "VNC auto-setup failed. Ensure SSH/Exploit Box is configured.",
    });
  }
};

export const diagnoseVNC = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    const session = await requireActiveSession(res.locals.userId, sessionId, res);
    if (!session) return;
    console.log("[VNC Diagnose] Diagnose endpoint called");
    const checks = await runDiagnostics(sessionId);
    const allPassed = checks.every((c) => c.status === "pass");
    console.log(`[VNC Diagnose] All passed: ${allPassed}`);
    return res.status(200).json({ checks, allPassed });
  } catch (error: any) {
    console.error("[VNC Diagnose] Top-level error:", error);
    return res.status(400).json({
      message:
        error?.message || "Diagnostics failed. Ensure SSH is configured.",
    });
  }
};

export const repairVNC = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    const session = await requireActiveSession(res.locals.userId, sessionId, res);
    if (!session) return;
    const result = await repairVncSession(sessionId, req.body?.fix || "all");
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[VNC Repair] Top-level error:", error);
    return res.status(400).json({
      message: error?.message || "Repair failed. Ensure SSH is configured.",
    });
  }
};

