import {
  getVncDisplay,
  getVncRfbPort,
  getWebsockifyPort,
} from "../config/constants";
import { readEnvFile, updateEnvVars } from "../utils/envWriter";
import {
  APT_POLICY_GUARD_INSTALL,
  APT_POLICY_GUARD_REMOVE,
  hasVncPassword,
  isDockerInternalHost,
  writeVncPasswordCmd,
  xvncSecurityArgs,
} from "../utils/vncSetup";
import { generateRandomPassword } from "../utils/fileUtils";
import {
  WorkHostCommandClient,
  execOnWorkHost,
  resolveSessionWorkHost,
} from "./work-host.service";

/**
 * Everything about putting a VNC desktop on the session's work host: the
 * stored config (.env keys), the one-click provisioning pipeline, and the
 * diagnostics/repair flows. The HTTP layer only parses requests and maps the
 * outcomes to responses; all SSH orchestration lives here.
 */

const VNC_ENV_KEYS = {
  mode: "VNC_MODE",
  host: "VNC_HOST",
  port: "VNC_PORT",
  password: "VNC_PASSWORD",
  setupDone: "VNC_SETUP_DONE",
  baseUrl: "VNC_BASE_URL",
};

// ─── Stored config ───────────────────────────────────────────────────

export interface VncConfig {
  mode: string;
  host: string;
  port: string;
  password: string;
  setupDone: boolean;
  baseUrl: string;
  configured: boolean;
}

export function getVncConfig(): VncConfig {
  const env = readEnvFile();
  const mode = env[VNC_ENV_KEYS.mode] || "";
  const host = env[VNC_ENV_KEYS.host] || "";
  const port = env[VNC_ENV_KEYS.port] || "9020";
  const password = env[VNC_ENV_KEYS.password] || "";
  const setupDone = env[VNC_ENV_KEYS.setupDone] === "true";
  const baseUrl = (env[VNC_ENV_KEYS.baseUrl] || "").trim();

  const configured = !!(
    mode &&
    (mode === "manual" ? host && password : setupDone)
  );

  return { mode, host, port, password, setupDone, baseUrl, configured };
}

export function updateVncConfig(input: {
  mode?: string;
  host?: string;
  port?: number | string;
  password?: string;
  baseUrl?: string;
}): void {
  const { mode, host, port, password, baseUrl } = input;
  const env = readEnvFile();

  if (!mode || !["auto", "manual"].includes(mode)) {
    throw new Error("Mode must be 'auto' or 'manual'");
  }

  if (mode === "manual" && (!host || !password)) {
    throw new Error("Host and password are required for manual mode");
  }

  updateEnvVars({
    [VNC_ENV_KEYS.mode]: mode,
    [VNC_ENV_KEYS.host]: host ?? env[VNC_ENV_KEYS.host] ?? "",
    [VNC_ENV_KEYS.port]: String(port ?? env[VNC_ENV_KEYS.port] ?? 9020),
    [VNC_ENV_KEYS.password]:
      password !== undefined && password !== ""
        ? password
        : env[VNC_ENV_KEYS.password] || "",
    [VNC_ENV_KEYS.setupDone]:
      mode === "manual" ? "true" : env[VNC_ENV_KEYS.setupDone] || "false",
    [VNC_ENV_KEYS.baseUrl]: typeof baseUrl === "string" ? baseUrl.trim() : "",
  });
}

export function resetVncConfig(): void {
  updateEnvVars({
    [VNC_ENV_KEYS.mode]: "",
    [VNC_ENV_KEYS.host]: "",
    [VNC_ENV_KEYS.port]: "",
    [VNC_ENV_KEYS.password]: "",
    [VNC_ENV_KEYS.setupDone]: "",
    [VNC_ENV_KEYS.baseUrl]: "",
  });
}

// ─── One-click provisioning ──────────────────────────────────────────

export interface VncProvisionStep {
  label: string;
  done: boolean;
}

export interface VncProvisionResult {
  message: string;
  vncURL: string;
  password: string;
  steps: VncProvisionStep[];
}

export async function provisionVnc(sessionId: string): Promise<VncProvisionResult> {
  const VNC_DISPLAY = getVncDisplay();
  const VNC_RFBPORT = getVncRfbPort();
  const WEBSOCKIFY_PORT = getWebsockifyPort();

  const target = await resolveSessionWorkHost(sessionId);
  const sshClient = new WorkHostCommandClient(sessionId);

  return new Promise<VncProvisionResult>((resolve, reject) => {
    sshClient
      .on("ready", async () => {
        try {
          const steps: VncProvisionStep[] = [
            { label: "Checking for VNC server", done: false },
            { label: "Installing VNC & GUI packages", done: false },
            { label: "Configuring VNC", done: false },
            { label: "Starting VNC server", done: false },
            { label: "Starting noVNC proxy", done: false },
          ];

          const execCmd = (cmd: string): Promise<string> => {
            return new Promise((resolve, reject) => {
              sshClient.exec(cmd, (err, stream) => {
                if (err) return reject(err);
                let out = "";
                stream
                  .on("close", () => resolve(out))
                  .on("data", (d: Buffer) => {
                    out += d.toString();
                  })
                  .stderr.on("data", (d: Buffer) => {
                    out += d.toString();
                  });
              });
            });
          };

          // Step 1: Check if VNC + websockify already installed
          let vncBin = "";
          const vncRaw = await execCmd(VNC_SEARCH_CMD);
          vncBin = parseVncPath(vncRaw);

          let wsInstalled = false;
          try {
            const wsRaw = await execCmd("command -v websockify 2>/dev/null");
            wsInstalled = parseVncPath(wsRaw).length > 0;
          } catch {
            /* not installed */
          }

          const alreadyInstalled = vncBin.length > 0 && wsInstalled;
          steps[0].done = true;

          // Step 2: Install packages if anything is missing
          if (!alreadyInstalled) {
            // Deny apt maintainer scripts from starting services so the install
            // doesn't hang on containers without an init system.
            await execCmd(APT_POLICY_GUARD_INSTALL);
            // Install Xvnc + lightweight GUI deps; try tigervnc first, fall back to tightvncserver
            await execCmd(
              "export DEBIAN_FRONTEND=noninteractive && " +
                "sudo apt-get update -qq 2>&1 && " +
                "sudo apt-get install -y -qq " +
                "tigervnc-standalone-server tigervnc-common " +
                // x11vnc provides -storepasswd, used to write a VNC passwd file
                // when the distro's tigervnc ships no vncpasswd binary.
                "x11vnc " +
                "novnc python3-websockify " +
                "xterm xfonts-base x11-xserver-utils " +
                "dbus-x11 2>&1 || true",
            );

            // If tigervnc failed (no Xvnc), try tightvncserver as fallback
            let recheck = await execCmd(VNC_SEARCH_CMD);
            vncBin = parseVncPath(recheck);
            if (!vncBin) {
              await execCmd(
                "export DEBIAN_FRONTEND=noninteractive && " +
                  "sudo apt-get install -y -qq tightvncserver 2>&1 || true",
              );
              recheck = await execCmd(VNC_SEARCH_CMD);
              vncBin = parseVncPath(recheck);
            }
            await execCmd(APT_POLICY_GUARD_REMOVE);

            if (!vncBin) {
              const dpkgInfo = await execCmd(
                "dpkg -l | grep -i vnc 2>/dev/null || true",
              ).catch(() => "");
              const findInfo = await execCmd(
                "find /usr -maxdepth 4 -type f \\( -name '*vnc*' -o -name '*Xvnc*' \\) 2>/dev/null | head -20",
              ).catch(() => "");
              console.log(
                "VNC binary not found after install. dpkg:",
                dpkgInfo,
                "find:",
                findInfo,
              );
              sshClient.end();
              reject(
                new Error(
                  `VNC binary not found after package install. Installed VNC packages: ${
                    dpkgInfo
                      .trim()
                      .split("\n")
                      .filter((l) => l.startsWith("ii"))
                      .map((l) => l.split(/\s+/)[1])
                      .join(", ") || "none"
                  }. Found files: ${findInfo.trim().split("\n").slice(0, 5).join(", ") || "none"}`,
                ),
              );
              return;
            }
          }
          steps[1].done = true;

          const isXvncDirect =
            vncBin.endsWith("Xvnc") || vncBin.endsWith("Xtigervnc");
          const isX11vnc = vncBin.endsWith("x11vnc");

          // Step 3: Configure VNC
          const randomPassword = generateRandomPassword();
          await execCmd(
            `mkdir -p ~/.vnc && ` +
              `printf '#!/bin/bash\\nexport DISPLAY=${VNC_DISPLAY}\\n[ -f $HOME/.Xresources ] && xrdb $HOME/.Xresources\\nif command -v startxfce4 >/dev/null 2>&1; then\\n  startxfce4 &\\nelif command -v openbox-session >/dev/null 2>&1; then\\n  openbox-session &\\nelse\\n  xterm &\\nfi\\n' > ~/.vnc/xstartup && ` +
              `chmod +x ~/.vnc/xstartup`,
          );
          // Kill all existing VNC/Xvfb processes for a clean start
          await execCmd(
            `vncserver -kill "${VNC_DISPLAY}" 2>/dev/null || true; ` +
              `pkill -f '[x]11vnc.*-display ${VNC_DISPLAY}.*-rfbport ${VNC_RFBPORT}' 2>/dev/null || true; ` +
              `pkill -f '[X]vfb ${VNC_DISPLAY}' 2>/dev/null || true; ` +
              `pkill -f '[X](vnc|tigervnc).*${VNC_DISPLAY}.*rfbport ${VNC_RFBPORT}' 2>/dev/null || true`,
          );
          const escapedPw = randomPassword.replace(/'/g, "'\\''");
          // Write a VNC passwd file (vncpasswd / tigervncpasswd / x11vnc
          // -storepasswd). Only if none of those exist do we fall back to no
          // auth so the box still comes up.
          let useVncAuth = false;
          if (!isX11vnc) {
            const pwProbe = await execCmd(writeVncPasswordCmd(escapedPw));
            useVncAuth = hasVncPassword(pwProbe);
          }
          steps[2].done = true;

          // Step 4: Start VNC server with DISPLAY=${VNC_DISPLAY}
          if (isXvncDirect) {
            await execCmd(
              `${vncBin} ${VNC_DISPLAY} -geometry 1280x800 -depth 24 -rfbport ${VNC_RFBPORT} ` +
                `${xvncSecurityArgs(useVncAuth)} ` +
                `-pn > /dev/null 2>&1 < /dev/null &`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await execCmd(`export DISPLAY=${VNC_DISPLAY} && ~/.vnc/xstartup > /dev/null 2>&1 < /dev/null &`);
          } else if (isX11vnc) {
            await execCmd(
              "command -v Xvfb >/dev/null 2>&1 || " +
                "(export DEBIAN_FRONTEND=noninteractive && sudo apt-get install -y -qq xvfb 2>&1 || true)",
            );
            await execCmd(
              `Xvfb ${VNC_DISPLAY} -screen 0 1280x800x24 > /dev/null 2>&1 < /dev/null &`,
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await execCmd(`export DISPLAY=${VNC_DISPLAY} && ~/.vnc/xstartup > /dev/null 2>&1 < /dev/null &`);
            await execCmd(
              `x11vnc -display ${VNC_DISPLAY} -rfbport ${VNC_RFBPORT} -passwd '${escapedPw}' ` +
                `-forever -shared -noxdamage > /dev/null 2>&1 < /dev/null &`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
            // Verify x11vnc actually started
            const verify = await execCmd(
              `(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ':${VNC_RFBPORT}' || echo NOTLISTENING`,
            );
            if (verify.includes("NOTLISTENING")) {
              sshClient.end();
              reject(
                new Error(
                  `x11vnc failed to start on rfbport ${VNC_RFBPORT}. Check that display ${VNC_DISPLAY} is available and no other process uses port ${VNC_RFBPORT}.`,
                ),
              );
              return;
            }
          } else {
            await execCmd(
              `${vncBin} -geometry 1280x800 -depth 24 ${VNC_DISPLAY}`,
            );
          }
          // Ensure DISPLAY is exported in the user's shell profile
          await execCmd(
            `grep -q "export DISPLAY=${VNC_DISPLAY}" ~/.bashrc 2>/dev/null || ` +
              `echo "export DISPLAY=${VNC_DISPLAY}" >> ~/.bashrc`,
          );
          steps[3].done = true;

          // Step 5: Start noVNC proxy. Bracketed pattern so pkill cannot match
          // the shell running this command (self-kill hangs the SSH exec).
          await execCmd(
            `pkill -f '[w]ebsockify.*${WEBSOCKIFY_PORT}' 2>/dev/null || true`,
          );
          await execCmd(
            `websockify --web /usr/share/novnc/ ${WEBSOCKIFY_PORT} localhost:${VNC_RFBPORT} > /dev/null 2>&1 < /dev/null &`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          steps[4].done = true;

          const vncHost = target.kind === "ssh" ? target.sshProfile?.host || "localhost" : "localhost";
          const vncPort = "9020";

          const baseUrl = isDockerInternalHost(vncHost)
            ? `http://localhost:${vncPort}`
            : "";

          // When Xvnc had no vncpasswd binary it starts without auth; surface an
          // empty password so the client doesn't prompt for an unused one.
          const passwordProtected = isX11vnc || useVncAuth;
          const effectivePassword = passwordProtected ? randomPassword : "";

          updateEnvVars({
            [VNC_ENV_KEYS.mode]: "auto",
            [VNC_ENV_KEYS.host]: vncHost,
            [VNC_ENV_KEYS.port]: vncPort,
            [VNC_ENV_KEYS.password]: effectivePassword,
            [VNC_ENV_KEYS.setupDone]: "true",
            [VNC_ENV_KEYS.baseUrl]: baseUrl,
          });

          sshClient.end();

          resolve({
            message: passwordProtected
              ? "VNC setup completed successfully"
              : "VNC setup completed. No vncpasswd binary was available, so VNC "
                + "auth is disabled — access is protected by the SSH tunnel only.",
            vncURL: `${vncHost}:${vncPort}`,
            password: effectivePassword,
            steps,
          });
        } catch (error) {
          sshClient.end();
          console.log("VNC auto-setup error:", error);
          reject(
            new Error(
              "VNC setup failed during installation. Ensure the exploit box has internet access for package installation.",
            ),
          );
        }
      })
      .on("error", (err: Error) => {
        console.log("SSH connection error during VNC setup:", err);
        reject(
          new Error(
            "Cannot connect to exploit box via SSH. Please configure SSH settings first.",
          ),
        );
      });

    sshClient.connect();
  });
}

// ─── Diagnostics & Repair ────────────────────────────────────────────

export interface DiagCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const VNC_SEARCH_CMD = [
  'export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:/usr/libexec";',
  // Prefer Xvnc/Xtigervnc (the actual binaries) over wrapper scripts
  "for b in Xvnc Xtigervnc vncserver tigervncserver x11vnc; do",
  '  p="$(command -v "$b" 2>/dev/null)" && [ -x "$p" ] && echo "$p" && exit 0;',
  "done;",
  "for p in /usr/bin/Xvnc /usr/bin/Xtigervnc /usr/bin/vncserver /usr/bin/tigervncserver",
  "  /usr/local/bin/Xvnc /usr/local/bin/vncserver /usr/libexec/vncserver /usr/sbin/vncserver",
  "  /usr/bin/x11vnc /snap/bin/vncserver; do",
  '  [ -x "$p" ] && echo "$p" && exit 0;',
  "done;",
  'dpkg -L tigervnc-standalone-server 2>/dev/null | grep -m1 -E "/(Xvnc|Xtigervnc|vncserver|tigervncserver)$";',
  'find /usr -maxdepth 4 \\( -name "Xvnc" -o -name "Xtigervnc" -o -name "vncserver" -o -name "tigervncserver" -o -name "x11vnc" \\) -type f 2>/dev/null | head -1',
].join(" ");

function parseVncPath(raw: string): string {
  for (const line of raw.trim().split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) return trimmed;
  }
  return "";
}

export async function runDiagnostics(sessionId: string): Promise<DiagCheck[]> {
  const VNC_DISPLAY = getVncDisplay();
  const VNC_RFBPORT = getVncRfbPort();
  const WEBSOCKIFY_PORT = getWebsockifyPort();
  const execSSHCommand = async (command: string, timeoutMs = 30_000) => {
    const result = await execOnWorkHost(sessionId, command, timeoutMs);
    return `${result.stdout}${result.stderr}`;
  };

  const checks: DiagCheck[] = [];
  console.log("[VNC Diagnose] Starting diagnostics...");

  // 1. SSH connectivity
  try {
    const whoami = await execSSHCommand("whoami");
    console.log(`[VNC Diagnose] SSH: connected as ${whoami.trim()}`);
    checks.push({
      id: "ssh",
      label: "SSH connectivity",
      status: "pass",
      detail: `Connected as ${whoami.trim()}`,
    });
  } catch (err: any) {
    console.error(
      "[VNC Diagnose] SSH: connection failed:",
      err?.message || err,
    );
    checks.push({
      id: "ssh",
      label: "SSH connectivity",
      status: "fail",
      detail: err?.message || "Cannot connect via SSH",
    });
    const skipRest = [
      "vnc_installed",
      "websockify_installed",
      "vnc_running",
      "websockify_running",
      "novnc_reachable",
    ];
    for (const id of skipRest) {
      checks.push({
        id,
        label: "",
        status: "skip",
        detail: "Skipped — SSH failed",
      });
    }
    return checks;
  }

  // 2. VNC server installed
  let vncBinaryPath = "";
  try {
    const out = await execSSHCommand(VNC_SEARCH_CMD);
    console.log("[VNC Diagnose] VNC search raw output:", out.trim());
    vncBinaryPath = parseVncPath(out);
    const found = vncBinaryPath.length > 0;
    console.log(
      `[VNC Diagnose] VNC installed: ${found ? vncBinaryPath : "NOT FOUND"}`,
    );
    checks.push({
      id: "vnc_installed",
      label: "VNC server installed",
      status: found ? "pass" : "fail",
      detail: found
        ? `Found: ${vncBinaryPath}`
        : "No VNC binary found (vncserver, Xvnc, Xtigervnc)",
    });
  } catch (err: any) {
    console.error(
      "[VNC Diagnose] VNC installed check failed:",
      err?.message || err,
    );
    checks.push({
      id: "vnc_installed",
      label: "VNC server installed",
      status: "fail",
      detail: "Check failed",
    });
  }

  // 3. Websockify installed
  try {
    const out = await execSSHCommand(
      "which websockify 2>/dev/null && echo FOUND || echo MISSING",
    );
    const found = out.trim().endsWith("FOUND");
    console.log(
      `[VNC Diagnose] Websockify installed: ${found ? out.split("\\n")[0]?.trim() : "NOT FOUND"}`,
    );
    checks.push({
      id: "websockify_installed",
      label: "Websockify (noVNC proxy) installed",
      status: found ? "pass" : "fail",
      detail: found
        ? `websockify at ${out.split("\n")[0]?.trim()}`
        : "websockify not found in PATH",
    });
  } catch (err: any) {
    console.error(
      "[VNC Diagnose] Websockify installed check failed:",
      err?.message || err,
    );
    checks.push({
      id: "websockify_installed",
      label: "Websockify installed",
      status: "fail",
      detail: "Check failed",
    });
  }

  // 4. VNC server running on DISPLAY=${VNC_DISPLAY} (rfbport ${VNC_RFBPORT})
  try {
    const psOut = await execSSHCommand(
      "ps aux 2>/dev/null | grep -E 'Xvnc|Xtigervnc|Xvfb|x11vnc|vncserver' | grep -v grep || true",
    );
    console.log("[VNC Diagnose] VNC processes:\n", psOut.trim() || "(none)");

    const portCheck = await execSSHCommand(
      `(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ':${VNC_RFBPORT}' || true`,
    );
    console.log(
      `[VNC Diagnose] Port ${VNC_RFBPORT} check:`,
      portCheck.trim() || "(not listening)",
    );
    const rfbPortListening = portCheck.trim().length > 0;

    const hasAnyVnc = psOut.trim().length > 0;

    const healthy = rfbPortListening;
    let detail = "";
    if (rfbPortListening) {
      detail = `VNC listening on rfbport ${VNC_RFBPORT} (DISPLAY=${VNC_DISPLAY})`;
    } else if (hasAnyVnc) {
      detail = `VNC process found but not listening on port ${VNC_RFBPORT}. Run repair to fix.`;
    } else {
      detail = "No VNC server process found";
    }
    console.log(
      `[VNC Diagnose] VNC running: ${healthy ? "PASS" : "FAIL"} — ${detail}`,
    );

    checks.push({
      id: "vnc_running",
      label: `VNC on DISPLAY=${VNC_DISPLAY} (port ${VNC_RFBPORT})`,
      status: healthy ? "pass" : "fail",
      detail,
    });
  } catch (err: any) {
    console.error(
      "[VNC Diagnose] VNC running check failed:",
      err?.message || err,
    );
    checks.push({
      id: "vnc_running",
      label: `VNC on DISPLAY=${VNC_DISPLAY}`,
      status: "fail",
      detail: "Check failed",
    });
  }

  // 5. Websockify running: port ${WEBSOCKIFY_PORT} -> localhost:${VNC_RFBPORT}
  try {
    const out = await execSSHCommand(
      "ps aux 2>/dev/null | grep 'websockify' | grep -v grep || true",
    );
    console.log(
      "[VNC Diagnose] Websockify processes:\n",
      out.trim() || "(none)",
    );
    const lines = out
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const correctProxy = lines.some(
      (l) =>
        l.includes(String(WEBSOCKIFY_PORT)) && l.includes(String(VNC_RFBPORT)),
    );
    const anyWs = lines.length > 0;

    const status: "pass" | "fail" = correctProxy ? "pass" : "fail";
    let detail = "";
    if (correctProxy) {
      detail = `websockify proxying ${WEBSOCKIFY_PORT} → localhost:${VNC_RFBPORT}`;
    } else if (anyWs) {
      detail = `websockify running but not proxying ${WEBSOCKIFY_PORT} → ${VNC_RFBPORT}. Run repair to fix.`;
    } else {
      detail = "No websockify process found";
    }
    console.log(
      `[VNC Diagnose] Websockify running: ${status.toUpperCase()} — ${detail}`,
    );

    checks.push({
      id: "websockify_running",
      label: `Websockify on port ${WEBSOCKIFY_PORT} → ${VNC_RFBPORT}`,
      status,
      detail,
    });
  } catch (err: any) {
    console.error(
      "[VNC Diagnose] Websockify running check failed:",
      err?.message || err,
    );
    checks.push({
      id: "websockify_running",
      label: "Websockify running",
      status: "fail",
      detail: "Check failed",
    });
  }

  // 6. noVNC reachable locally
  try {
    const out = await execSSHCommand(
      `curl -s -o /dev/null -w "%{http_code}" http://localhost:${WEBSOCKIFY_PORT}/ 2>/dev/null || echo 000`,
    );
    const code = out.trim();
    const ok = code === "200" || code === "301" || code === "302";
    console.log(
      `[VNC Diagnose] noVNC reachable: HTTP ${code} — ${ok ? "PASS" : "FAIL"}`,
    );
    checks.push({
      id: "novnc_reachable",
      label: `noVNC web UI reachable (localhost:${WEBSOCKIFY_PORT})`,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `HTTP ${code}`
        : `HTTP ${code} — noVNC not responding on port ${WEBSOCKIFY_PORT}`,
    });
  } catch (err: any) {
    console.error(
      "[VNC Diagnose] noVNC reachable check failed:",
      err?.message || err,
    );
    checks.push({
      id: "novnc_reachable",
      label: "noVNC reachable",
      status: "fail",
      detail: "Check failed",
    });
  }

  console.log(
    "[VNC Diagnose] Completed. Results:",
    JSON.stringify(checks, null, 2),
  );
  return checks;
}

export async function repairVnc(
  sessionId: string,
  fix: string = "all",
): Promise<{ checks: DiagCheck[]; allPassed: boolean; repairLog: string[] }> {
  const VNC_DISPLAY = getVncDisplay();
  const VNC_RFBPORT = getVncRfbPort();
  const WEBSOCKIFY_PORT = getWebsockifyPort();
  const execSSHCommand = async (command: string, timeoutMs = 120_000) => {
    const result = await execOnWorkHost(sessionId, command, timeoutMs);
    return `${result.stdout}${result.stderr}`;
  };
  const env = readEnvFile();
  const savedPassword = env[VNC_ENV_KEYS.password] || "";

  console.log(`[VNC Repair] Starting repair (fix=${fix})`);

  const log: string[] = [];

  // Discover which VNC binary is actually available
  let vncBin = "vncserver";
  let vncMissing = false;
  try {
    const raw = await execSSHCommand(VNC_SEARCH_CMD);
    console.log("[VNC Repair] VNC search raw output:", raw.trim());
    const found = parseVncPath(raw);
    if (found) {
      vncBin = found;
      log.push(`Using VNC binary: ${vncBin}`);
      console.log(`[VNC Repair] Using VNC binary: ${vncBin}`);
    } else {
      vncMissing = true;
      console.log("[VNC Repair] VNC binary not found");
    }
  } catch (e: any) {
    vncMissing = true;
    console.error("[VNC Repair] VNC search failed:", e?.message || e);
  }

  // Check if websockify is missing too
  let websockifyMissing = false;
  try {
    const wsOut = await execSSHCommand("command -v websockify 2>/dev/null");
    if (!parseVncPath(wsOut)) {
      websockifyMissing = true;
      console.log("[VNC Repair] Websockify not found");
    } else {
      console.log("[VNC Repair] Websockify found:", wsOut.trim());
    }
  } catch {
    websockifyMissing = true;
    console.log("[VNC Repair] Websockify check failed");
  }

  // Install missing packages
  if (
    (fix === "all" || fix === "vnc_server") &&
    (vncMissing || websockifyMissing)
  ) {
    log.push("Installing missing VNC/noVNC packages...");
    console.log(
      "[VNC Repair] Installing packages (vncMissing=%s, websockifyMissing=%s)",
      vncMissing,
      websockifyMissing,
    );
    try {
      const installOut = await execSSHCommand(
        "export DEBIAN_FRONTEND=noninteractive && " +
          "sudo apt-get update -qq 2>&1 && " +
          "sudo apt-get install -y -qq " +
          "tigervnc-standalone-server tigervnc-common " +
          "novnc python3-websockify " +
          "xterm xfonts-base x11-xserver-utils dbus-x11 2>&1 || true",
      );
      console.log(
        "[VNC Repair] Package install output:",
        installOut.trim().slice(-500),
      );
      log.push("Package installation completed");

      let found = parseVncPath(await execSSHCommand(VNC_SEARCH_CMD));
      if (!found) {
        log.push("tigervnc not found, trying tightvncserver fallback...");
        console.log(
          "[VNC Repair] tigervnc not found, trying tightvncserver...",
        );
        await execSSHCommand(
          "export DEBIAN_FRONTEND=noninteractive && " +
            "sudo apt-get install -y -qq tightvncserver 2>&1 || true",
        );
        found = parseVncPath(await execSSHCommand(VNC_SEARCH_CMD));
      }
      if (found) {
        vncBin = found;
        vncMissing = false;
        log.push(`VNC binary now available: ${vncBin}`);
        console.log(`[VNC Repair] VNC binary now available: ${vncBin}`);
      } else {
        log.push("WARNING: VNC binary still not found after install");
        console.warn(
          "[VNC Repair] WARNING: VNC binary still not found after install",
        );
      }
    } catch (e: any) {
      log.push(`Package install failed: ${e.message}`);
      console.error("[VNC Repair] Package install failed:", e.message);
    }
  }

  if (fix === "all" || fix === "vnc_server") {
    const isXvncDirect =
      vncBin.endsWith("Xvnc") || vncBin.endsWith("Xtigervnc");
    const isX11vnc = vncBin.endsWith("x11vnc");
    console.log(
      `[VNC Repair] VNC type: isXvncDirect=${isXvncDirect}, isX11vnc=${isX11vnc}, binary=${vncBin}`,
    );

    try {
      await execSSHCommand(
        `mkdir -p ~/.vnc && ` +
          `printf '#!/bin/bash\\nexport DISPLAY=${VNC_DISPLAY}\\n[ -f $HOME/.Xresources ] && xrdb $HOME/.Xresources\\nif command -v startxfce4 >/dev/null 2>&1; then\\n  startxfce4 &\\nelif command -v openbox-session >/dev/null 2>&1; then\\n  openbox-session &\\nelse\\n  xterm &\\nfi\\n' > ~/.vnc/xstartup && ` +
          `chmod +x ~/.vnc/xstartup`,
      );
      log.push(`Configured xstartup with DISPLAY=${VNC_DISPLAY}`);
      console.log(
        `[VNC Repair] Configured xstartup with DISPLAY=${VNC_DISPLAY}`,
      );
    } catch (e: any) {
      log.push(`xstartup config failed: ${e.message}`);
      console.error("[VNC Repair] xstartup config failed:", e.message);
    }

    try {
      await execSSHCommand(
        `vncserver -kill "${VNC_DISPLAY}" 2>/dev/null || true; ` +
          `pkill -f '[x]11vnc.*-display ${VNC_DISPLAY}.*-rfbport ${VNC_RFBPORT}' 2>/dev/null || true; ` +
          `pkill -f '[X]vfb ${VNC_DISPLAY}' 2>/dev/null || true; ` +
          `pkill -f '[X](vnc|tigervnc).*${VNC_DISPLAY}.*rfbport ${VNC_RFBPORT}' 2>/dev/null || true`,
      );
      log.push("Killed all existing VNC/Xvfb processes");
      console.log("[VNC Repair] Killed all existing VNC/Xvfb processes");
    } catch (e: any) {
      log.push(`Kill VNC failed: ${e.message}`);
      console.error("[VNC Repair] Kill VNC failed:", e.message);
    }

    let useVncAuth = false;
    if (savedPassword && !isX11vnc) {
      try {
        const escaped = savedPassword.replace(/'/g, "'\\''");
        const pwProbe = await execSSHCommand(writeVncPasswordCmd(escaped));
        useVncAuth = hasVncPassword(pwProbe);
        log.push(
          useVncAuth
            ? "Set VNC password"
            : "No vncpasswd binary; starting Xvnc without auth (SSH-tunnel only)",
        );
        console.log(
          `[VNC Repair] VNC auth: ${useVncAuth ? "VncAuth" : "None (no vncpasswd)"}`,
        );
      } catch (e: any) {
        log.push(`Set password failed: ${e.message}`);
        console.error("[VNC Repair] Set password failed:", e.message);
      }
    }

    try {
      if (isXvncDirect) {
        console.log(
          `[VNC Repair] Starting Xvnc directly: ${vncBin} ${VNC_DISPLAY} rfbport=${VNC_RFBPORT}`,
        );
        await execSSHCommand(
          `${vncBin} ${VNC_DISPLAY} -geometry 1280x800 -depth 24 -rfbport ${VNC_RFBPORT} ` +
            `${xvncSecurityArgs(useVncAuth)} ` +
            `-pn > /dev/null 2>&1 < /dev/null &`,
        );
        await new Promise((r) => setTimeout(r, 1500));
        await execSSHCommand(
          `export DISPLAY=${VNC_DISPLAY} && ~/.vnc/xstartup > /dev/null 2>&1 < /dev/null &`,
        );
        log.push(`Started Xvnc directly on ${VNC_DISPLAY}`);
        console.log(`[VNC Repair] Started Xvnc directly on ${VNC_DISPLAY}`);
      } else if (isX11vnc) {
        console.log(
          `[VNC Repair] Starting x11vnc flow: Xvfb ${VNC_DISPLAY} + x11vnc rfbport=${VNC_RFBPORT}`,
        );
        await execSSHCommand(
          "command -v Xvfb >/dev/null 2>&1 || " +
            "(export DEBIAN_FRONTEND=noninteractive && sudo apt-get install -y -qq xvfb 2>&1 || true)",
        );
        await execSSHCommand(
          `Xvfb ${VNC_DISPLAY} -screen 0 1280x800x24 > /dev/null 2>&1 < /dev/null &`,
        );
        await new Promise((r) => setTimeout(r, 2000));

        // Verify Xvfb started
        const xvfbCheck = await execSSHCommand(
          `ps aux 2>/dev/null | grep 'Xvfb.*${VNC_DISPLAY}' | grep -v grep || true`,
        );
        console.log(
          "[VNC Repair] Xvfb process check:",
          xvfbCheck.trim() || "(not found)",
        );

        await execSSHCommand(
          `export DISPLAY=${VNC_DISPLAY} && ~/.vnc/xstartup > /dev/null 2>&1 < /dev/null &`,
        );
        const escaped = (savedPassword || "").replace(/'/g, "'\\''");
        await execSSHCommand(
          `x11vnc -display ${VNC_DISPLAY} -rfbport ${VNC_RFBPORT} -passwd '${escaped}' -forever -shared -noxdamage > /dev/null 2>&1 < /dev/null &`,
        );
        await new Promise((r) => setTimeout(r, 1500));

        // Verify x11vnc started and port is listening
        const portCheck = await execSSHCommand(
          `(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ':${VNC_RFBPORT}' || echo NOTLISTENING`,
        );
        console.log(
          `[VNC Repair] Port ${VNC_RFBPORT} check after x11vnc start:`,
          portCheck.trim(),
        );
        if (portCheck.includes("NOTLISTENING")) {
          log.push(
            `WARNING: x11vnc started but port ${VNC_RFBPORT} not listening`,
          );
          console.warn(
            `[VNC Repair] x11vnc started but port ${VNC_RFBPORT} not listening`,
          );
        } else {
          log.push(`Started x11vnc with Xvfb on ${VNC_DISPLAY}`);
          console.log(
            `[VNC Repair] Started x11vnc with Xvfb on ${VNC_DISPLAY}`,
          );
        }
      } else {
        console.log(
          `[VNC Repair] Starting via vncserver wrapper: ${vncBin} ${VNC_DISPLAY}`,
        );
        await execSSHCommand(
          `${vncBin} -geometry 1280x800 -depth 24 ${VNC_DISPLAY}`,
        );
        log.push(`Started VNC server on ${VNC_DISPLAY}`);
        console.log(`[VNC Repair] Started VNC server on ${VNC_DISPLAY}`);
      }
      await execSSHCommand(
        `grep -q "export DISPLAY=${VNC_DISPLAY}" ~/.bashrc 2>/dev/null || echo "export DISPLAY=${VNC_DISPLAY}" >> ~/.bashrc`,
      );
      console.log(`[VNC Repair] Ensured DISPLAY=${VNC_DISPLAY} in ~/.bashrc`);
    } catch (e: any) {
      log.push(`Start VNC failed: ${e.message}`);
      console.error("[VNC Repair] Start VNC failed:", e.message);
    }
  }

  if (fix === "all" || fix === "websockify") {
    try {
      await execSSHCommand(
        `pkill -f '[w]ebsockify.*${WEBSOCKIFY_PORT}' 2>/dev/null || true`,
      );
      log.push("Killed existing websockify");
      console.log("[VNC Repair] Killed existing websockify");
    } catch (e: any) {
      log.push(`Kill websockify failed: ${e.message}`);
      console.error("[VNC Repair] Kill websockify failed:", e.message);
    }

    try {
      await execSSHCommand(
        `websockify --web /usr/share/novnc/ ${WEBSOCKIFY_PORT} localhost:${VNC_RFBPORT} > /dev/null 2>&1 < /dev/null &`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      log.push(`Started websockify on port ${WEBSOCKIFY_PORT}`);
      console.log(
        `[VNC Repair] Started websockify ${WEBSOCKIFY_PORT} → localhost:${VNC_RFBPORT}`,
      );
    } catch (e: any) {
      log.push(`Start websockify failed: ${e.message}`);
      console.error("[VNC Repair] Start websockify failed:", e.message);
    }
  }

  console.log(
    "[VNC Repair] Repair steps done. Running post-repair diagnostics...",
  );
  const checks = await runDiagnostics(sessionId);
  const allPassed = checks.every((c) => c.status === "pass");
  console.log(`[VNC Repair] Post-repair all passed: ${allPassed}. Log:`, log);

  return { checks, allPassed, repairLog: log };
}
