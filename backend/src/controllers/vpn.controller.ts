import { Response, Request } from "express";
import { Client as SSHClient } from "ssh2";
import { requireActiveSession } from "../services/session.helpers";
import {
  connectSSH,
  execOnWorkHost,
  resolveSessionWorkHost,
} from "../services/work-host.service";
import path from "path";
import fs from "fs";
import { KALI_DATA_DIR } from "../config/constants";

const VPN_DIR = path.join(KALI_DATA_DIR, "vpn-profiles");

function ensureVPNDir(): void {
  if (!fs.existsSync(VPN_DIR)) {
    fs.mkdirSync(VPN_DIR, { recursive: true });
  }
}

function sanitizeProfileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").substring(0, 64);
}

function listLocalProfiles(): Array<{ name: string; filename: string; path: string; assetDir: string; size: number }> {
  ensureVPNDir();
  const files = fs.readdirSync(VPN_DIR).filter((f: string) => f.endsWith(".ovpn") || f.endsWith(".conf"));
  return files.map((f: string) => {
    const fullPath = path.join(VPN_DIR, f);
    const stat = fs.statSync(fullPath);
    return {
      name: f.replace(/\.(ovpn|conf)$/, ""),
      filename: f,
      path: fullPath,
      assetDir: path.join(VPN_DIR, `${f.replace(/\.(ovpn|conf)$/, "")}.files`),
      size: stat.size,
    };
  });
}

function sshExecPromise(ssh: SSHClient, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      stream.on("close", (code: number) => {
        resolve({ stdout, stderr, code });
      });
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

/**
 * Wraps a command with sudo if needed. Uses the SSH password for `sudo -S`
 * when the SSH user is not root.
 * @param cmdOrPath - Command string to run via sh -c, or script path when isScriptPath is true
 * @param isScriptPath - When true, cmdOrPath is a file path to execute directly (avoids quoting issues)
 */
function sudoWrap(
  cmdOrPath: string,
  sshConfig: { username?: string; password?: string },
  isScriptPath = false
): string {
  const run = isScriptPath ? `bash ${shellEscape(cmdOrPath)}` : `sh -c ${shellEscape(cmdOrPath)}`;
  if (sshConfig.username === "root") return run;
  if (sshConfig.password) {
    return `echo ${shellEscape(sshConfig.password)} | sudo -S ${run}`;
  }
  return `sudo -n ${run}`;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function uploadFileViaSftp(ssh: SSHClient, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ssh.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => {
        if (e) return reject(e);
        resolve();
      });
    });
  });
}

// ── Upload VPN profile ──

export const uploadVPNProfile = async (req: Request, res: Response) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    const profileName = req.body.profile_name;

    const profileFiles = files.filter((file) => /\.(ovpn|conf)$/i.test(file.originalname));
    if (profileFiles.length !== 1) {
      return res.status(400).json({ message: "Upload exactly one .ovpn or .conf profile" });
    }
    const file = profileFiles[0];
    ensureVPNDir();

    const safeName = sanitizeProfileName(profileName || file.originalname.replace(/\.(ovpn|conf)$/, ""));
    if (!safeName) {
      return res.status(400).json({ message: "VPN profile name is invalid" });
    }
    const ext = file.originalname.endsWith(".conf") ? ".conf" : ".ovpn";
    const filename = safeName + ext;
    const filePath = path.join(VPN_DIR, filename);

    fs.rmSync(path.join(VPN_DIR, safeName + (ext === ".ovpn" ? ".conf" : ".ovpn")), { force: true });
    fs.writeFileSync(filePath, file.buffer, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    const assetDir = path.join(VPN_DIR, `${safeName}.files`);
    fs.rmSync(assetDir, { recursive: true, force: true });
    fs.mkdirSync(assetDir, { recursive: true });
    const assetNames = new Set<string>();
    for (const asset of files.filter((entry) => entry !== file)) {
      const assetName = path.basename(asset.originalname);
      if (assetNames.has(assetName)) {
        fs.rmSync(assetDir, { recursive: true, force: true });
        fs.rmSync(filePath, { force: true });
        return res.status(400).json({ message: `Duplicate VPN bundle filename: ${assetName}` });
      }
      assetNames.add(assetName);
      fs.writeFileSync(path.join(assetDir, assetName), asset.buffer, { mode: 0o600 });
    }

    return res.status(200).json({
      message: "VPN profile uploaded",
      profile: {
        name: safeName,
        filename,
        assets: files.length - 1,
      },
    });
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to upload VPN profile" });
  }
};

// ── List all VPN profiles ──

export const listVPNProfiles = async (req: Request, res: Response) => {
  try {
    const profiles = listLocalProfiles();
    return res.status(200).json({ profiles });
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to list VPN profiles" });
  }
};

// ── Delete a VPN profile ──

export const deleteVPNProfile = async (req: Request, res: Response) => {
  try {
    const { profile_name } = req.body;

    if (!profile_name) {
      return res.status(400).json({ message: "Profile name is required" });
    }

    const safeName = sanitizeProfileName(profile_name);
    const profiles = listLocalProfiles();
    const profile = profiles.find((p) => p.name === safeName);

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    fs.unlinkSync(profile.path);
    fs.rmSync(profile.assetDir, { recursive: true, force: true });

    return res.status(200).json({ message: "Profile deleted" });
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to delete VPN profile" });
  }
};

// ── Connect a specific VPN profile ──

export const connectVPNProfile = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { session_id, profile_name } = req.body;
    console.log("[vpn/connect] 1 request received", { session_id, profile_name, userId });

    if (!session_id) {
      return res.status(400).json({ message: "Invalid session id" });
    }

    if (!profile_name) {
      return res.status(400).json({ message: "Profile name is required" });
    }

    console.log("[vpn/connect] 2 fetching session...");
    const session = await requireActiveSession(userId, session_id, res);
    if (!session) return;
    console.log("[vpn/connect] 3 session ok");

    const safeName = sanitizeProfileName(profile_name);
    const profiles = listLocalProfiles();
    const profile = profiles.find((p) => p.name === safeName);

    if (!profile) {
      return res.status(404).json({ message: "VPN profile not found" });
    }
    console.log("[vpn/connect] 4 profile found", { path: profile.path });

    const profileContent = fs.readFileSync(profile.path, "utf8");
    if (/^\s*auth-user-pass\s*(?:#.*)?$/m.test(profileContent)) {
      return res.status(400).json({
        message: "This VPN requires an interactive username/password prompt. Add an auth-user-pass credentials file to the bundle or connect it manually on the work host.",
      });
    }

    console.log("[vpn/connect] 5 resolving workspace work host...");
    const target = await resolveSessionWorkHost(session_id);
    let ssh: SSHClient | null = null;

    try {
      if (target.kind === "local") {
        const preflight = await execOnWorkHost(
          session_id,
          "command -v openvpn >/dev/null 2>&1 && test -c /dev/net/tun",
          5_000,
        );
        if (preflight.code !== 0) {
          return res.status(400).json({
            message:
              "Local VPN requires OpenVPN and /dev/net/tun. Rebuild the backend and start it with NET_ADMIN (the bundled Docker Compose configuration includes both).",
          });
        }
      }
      const remoteDir = `/tmp/vpn-${safeName}`;
      const remotePath = `${remoteDir}/${profile.filename}`;
      if (target.kind === "ssh") {
        ssh = await withTimeout(connectSSH(target.sshConfig!, 15_000), 15_000, "SSH connect for VPN");
        const prepare = await sshExecPromise(ssh, `rm -rf ${shellEscape(remoteDir)} && mkdir -p ${shellEscape(remoteDir)}`);
        if (prepare.code !== 0) throw new Error(prepare.stderr || "Could not create VPN directory on the work host");
        await withTimeout(uploadFileViaSftp(ssh, profile.path, remotePath), 30_000, "Upload profile to work host");
        if (fs.existsSync(profile.assetDir)) {
          for (const asset of fs.readdirSync(profile.assetDir)) {
            await withTimeout(
              uploadFileViaSftp(ssh, path.join(profile.assetDir, asset), `${remoteDir}/${asset}`),
              30_000,
              `Upload VPN asset ${asset}`,
            );
          }
        }
      } else {
        await fs.promises.rm(remoteDir, { recursive: true, force: true });
        await fs.promises.mkdir(remoteDir, { recursive: true });
        await fs.promises.copyFile(profile.path, remotePath);
        if (fs.existsSync(profile.assetDir)) {
          for (const asset of fs.readdirSync(profile.assetDir)) {
            await fs.promises.copyFile(path.join(profile.assetDir, asset), `${remoteDir}/${asset}`);
          }
        }
      }

      const logFile = `/tmp/openvpn-${safeName}.log`;
      const pidFile = `/tmp/openvpn-${safeName}.pid`;
      const scriptPath = `/tmp/vpn-start-${safeName}.sh`;
      const scriptContent = [
        "#!/bin/bash",
        `rm -f ${pidFile}`,
        `openvpn --cd ${remoteDir} --config ${remotePath} --daemon --log ${logFile} --writepid ${pidFile}`,
        "sleep 2",
        `if [ -f ${pidFile} ] && kill -0 $(cat ${pidFile}) 2>/dev/null; then`,
        "  echo STARTED",
        "else",
        "  echo FAILED",
        `  [ -f ${logFile} ] && sed -n '1,120p' ${logFile}`,
        "fi",
      ].join("\n");

      if (target.kind === "ssh") {
        const localScriptPath = path.join(VPN_DIR, `vpn-start-${safeName}.sh`);
        fs.writeFileSync(localScriptPath, scriptContent, "utf8");
        try {
          await withTimeout(uploadFileViaSftp(ssh!, localScriptPath, scriptPath), 10_000, "Upload start script");
        } finally {
          fs.unlinkSync(localScriptPath);
        }
        ssh!.end();
        ssh = null;
      } else {
        await fs.promises.writeFile(scriptPath, scriptContent, { mode: 0o700 });
      }

      const privilege = target.kind === "ssh"
        ? target.sshConfig!
        : { username: process.getuid?.() === 0 ? "root" : process.env.USER };
      const startCmd = sudoWrap(scriptPath, privilege, true);

      console.log("[vpn/connect] 10 starting openvpn...", { profile: safeName, host: target.kind });
      const { stdout, stderr, code } = await withTimeout(
        execOnWorkHost(session_id, startCmd, 25_000),
        25_000,
        "OpenVPN start"
      );
      console.log("[vpn/connect] 11 openvpn start completed", {
        profile: safeName,
        code,
        stdout,
        stderr,
      });

      if (code === 0 && stdout.includes("STARTED")) {
        console.log("[vpn/connect] 12 success, sending response");
        return res.status(200).json({
          message: `VPN "${safeName}" connected`,
          profile_name: safeName,
        });
      } else {
        return res.status(400).json({
          message:
            stderr?.trim() ||
            stdout?.replace("FAILED", "").trim() ||
            `Failed to start VPN "${safeName}"`,
        });
      }
    } catch (err: any) {
      if (ssh) ssh.end();
      console.log("[vpn/connect] error:", err?.message ?? err);
      return res.status(400).json({ message: err.message ?? "Failed to connect VPN" });
    }
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to connect VPN" });
  }
};

// ── Disconnect a specific VPN connection ──

export const disconnectVPNConnection = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { session_id, pid, profile_name } = req.body;

    if (!session_id) {
      return res.status(400).json({ message: "Invalid session id" });
    }

    const session = await requireActiveSession(userId, session_id, res);
    if (!session) return;

    const target = await resolveSessionWorkHost(session_id);
    {
      let rawCmd: string;

      if (pid) {
        const numericPid = String(pid);
        if (!/^\d+$/.test(numericPid)) {
          return res.status(400).json({ message: "Invalid VPN process id" });
        }
        rawCmd = `found=0; for f in /tmp/openvpn-*.pid; do [ -f "$f" ] || continue; p=$(cat "$f"); [ "$p" = ${numericPid} ] || continue; cmd=$(ps -p "$p" -o args= 2>/dev/null); case "$cmd" in (*openvpn*'/tmp/vpn-'*) kill "$p" 2>/dev/null && found=1 ;; esac; [ "$found" = 1 ] && rm -f "$f"; done; [ "$found" = 1 ] && echo KILLED || echo NOT_FOUND`;
      } else if (profile_name) {
        const safeName = sanitizeProfileName(profile_name);
        const pidFile = `/tmp/openvpn-${safeName}.pid`;
        rawCmd = `if [ -f ${pidFile} ]; then p=$(cat ${pidFile}); cmd=$(ps -p "$p" -o args= 2>/dev/null); case "$cmd" in (*openvpn*'/tmp/vpn-${safeName}/'*) kill "$p" 2>/dev/null && rm -f ${pidFile} && echo KILLED ;; (*) echo NOT_FOUND ;; esac; else echo NOT_FOUND; fi`;
      } else {
        return res.status(400).json({ message: "Provide either pid or profile_name" });
      }

      const privilege = target.kind === "ssh" ? target.sshConfig! : { username: process.getuid?.() === 0 ? "root" : process.env.USER };
      const killCmd = sudoWrap(rawCmd, privilege);
      const { stdout } = await execOnWorkHost(session_id, killCmd, 15_000);

      if (stdout.trim().includes("KILLED")) {
        return res.status(200).json({ message: "VPN connection terminated" });
      } else if (stdout.trim().includes("NOT_FOUND")) {
        return res.status(404).json({ message: "VPN process not found" });
      } else {
        return res.status(400).json({ message: "Failed to disconnect VPN" });
      }
    }
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to disconnect VPN" });
  }
};

// ── Disconnect ALL VPN connections ──

export const disconnectAllVPN = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ message: "Invalid session id" });
    }

    const session = await requireActiveSession(userId, session_id, res);
    if (!session) return;

    const target = await resolveSessionWorkHost(session_id);
    {
      const rawCmd = "for f in /tmp/openvpn-*.pid; do [ -f \"$f\" ] || continue; p=$(cat \"$f\"); case \"$p\" in (*[!0-9]*|'') ;; (*) cmd=$(ps -p \"$p\" -o args= 2>/dev/null); case \"$cmd\" in (*openvpn*'/tmp/vpn-'*) kill \"$p\" 2>/dev/null ;; esac ;; esac; rm -f \"$f\"; done; rm -rf /tmp/vpn-*; echo 'DONE'";
      const privilege = target.kind === "ssh" ? target.sshConfig! : { username: process.getuid?.() === 0 ? "root" : process.env.USER };
      await execOnWorkHost(session_id, sudoWrap(rawCmd, privilege), 15_000);
      return res.status(200).json({ message: "All VPN connections terminated" });
    }
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to disconnect all VPNs" });
  }
};

// ── Get detailed VPN status ──

export const getVPNStatus = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ message: "Invalid session id" });
    }

    const session = await requireActiveSession(userId, session_id, res);
    if (!session) return;

    {
      const ownedProcessCommand = "for f in /tmp/openvpn-*.pid; do [ -f \"$f\" ] || continue; p=$(cat \"$f\"); case \"$p\" in (*[!0-9]*|'') continue ;; esac; cmd=$(ps -p \"$p\" -o args= 2>/dev/null); case \"$cmd\" in (*openvpn*'/tmp/vpn-'*) printf '%s|%s\\n' \"$p\" \"$cmd\" ;; esac; done";
      const { stdout: pgrepOut } = await execOnWorkHost(session_id, ownedProcessCommand, 10_000);

      if (!pgrepOut.trim()) {
        return res.status(200).json({
          success: false,
          connections: [],
          message: "No VPN connections active",
        });
      }

      const lines = pgrepOut.trim().split("\n").filter(Boolean);
      const connections: Array<{
        pid: string;
        profile_name: string;
        config_file: string;
      }> = [];

      for (const line of lines) {
        const separator = line.indexOf("|");
        if (separator === -1) continue;
        const pid = line.slice(0, separator);
        const parts = line.slice(separator + 1).trim().split(/\s+/);
        const configFlag = parts.indexOf("--config");
        let configFile = "";
        let profileName = "unknown";

        if (configFlag !== -1 && parts[configFlag + 1]) {
          configFile = parts[configFlag + 1];
          const basename = path.basename(configFile, path.extname(configFile));
          profileName = basename.replace(/^vpn-/, "");
        }

        connections.push({ pid, profile_name: profileName, config_file: configFile });
      }

      // Get tun interfaces and IPs
      const { stdout: ifOut } = await execOnWorkHost(session_id, "ip -4 addr show 2>/dev/null | grep -E '(^[0-9]+:|inet )' || true", 10_000);
      const tunInterfaces: Array<{ iface: string; ip: string }> = [];
      const ifLines = ifOut.split("\n");
      let currentIface = "";
      for (const ifLine of ifLines) {
        const ifaceMatch = ifLine.match(/^\d+:\s+(\S+?)[@:]/);
        if (ifaceMatch) {
          currentIface = ifaceMatch[1];
        }
        const inetMatch = ifLine.match(/inet\s+(\S+)/);
        if (inetMatch && currentIface.startsWith("tun")) {
          tunInterfaces.push({ iface: currentIface, ip: inetMatch[1] });
        }
      }

      const enrichedConnections = connections.map((conn, idx) => ({
        ...conn,
        tun_interface: tunInterfaces[idx]?.iface ?? null,
        tun_ip: tunInterfaces[idx]?.ip ?? null,
      }));

      return res.status(200).json({
        success: true,
        connections: enrichedConnections,
        message: `${enrichedConnections.length} VPN connection(s) active`,
      });
    }
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Failed to check VPN status" });
  }
};
