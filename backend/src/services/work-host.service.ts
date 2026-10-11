import path from "path";
import { Client as SSHClient } from "ssh2";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import WorkspaceModel, { WorkHostKind } from "../models/Workspace/Workspace.model";
import SessionsModel from "../models/Sessions/Sessions.model";
import { SSHConfig } from "../utils/sshConfig";
import {
  hasLegacyConfig,
  LEGACY_PROFILE_ALIAS,
  resolveSSHProfile,
  SSHProfileSummary,
} from "./ssh-profile.service";

const DEFAULT_WORK_ROOT = process.env.WORKSPACE_DIR || "~/pentest-workspaces";

export interface ResolvedWorkHost {
  workspaceId: string;
  kind: "ssh";
  workFolder: string;
  sshProfileAlias?: string;
  sshConfig?: SSHConfig;
  sshProfile?: SSHProfileSummary;
}

export interface WorkHostInput {
  kind: "ssh";
  workFolder: string;
  sshProfileAlias?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface DirectoryListing {
  homePath: string;
  currentPath: string;
  parentPath: string | null;
  directories: Array<{ name: string; path: string }>;
}

/**
 * The agent's commands run on the attack box over SSH and never inside the
 * backend: the backend holds the model keys, the database credentials and a
 * direct route to the internet, so it is not disposable test infrastructure and
 * it sits outside the egress fence that judges the attack box's traffic.
 */
export const NO_ATTACK_BOX_MESSAGE =
  "Agent commands run on the attack box over SSH, never inside the VulnPen backend. " +
  "Select an SSH profile for this workspace.";

export function defaultWorkFolder(workspaceId: string): string {
  return `${DEFAULT_WORK_ROOT.replace(/\/+$/, "")}/${workspaceId}`;
}

/** The host a workspace uses: its saved SSH host, else the environment's attack box. */
export function effectiveWorkHost(
  workspaceId: string,
  stored?: { kind: WorkHostKind; workFolder: string; sshProfileAlias?: string },
): { kind: "ssh"; workFolder: string; sshProfileAlias: string } {
  if (stored?.kind === "ssh" && stored.sshProfileAlias) {
    return { kind: "ssh", workFolder: stored.workFolder, sshProfileAlias: stored.sshProfileAlias };
  }
  return {
    kind: "ssh",
    workFolder: defaultWorkFolder(workspaceId),
    sshProfileAlias: hasLegacyConfig() ? LEGACY_PROFILE_ALIAS : "",
  };
}

export function validateWorkFolder(value: unknown): string {
  const folder = String(value ?? "").trim();
  if (!folder) throw new Error("Work folder is required");
  if (folder.length > 1024 || /[\0\r\n]/.test(folder)) {
    throw new Error("Work folder is invalid");
  }
  if (!(folder.startsWith("/") || folder === "~" || folder.startsWith("~/"))) {
    throw new Error("Work folder must be an absolute path or start with ~/");
  }
  return folder.replace(/\/+$/, "") || "/";
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A shell expression for a validated path which keeps remote $HOME expansion. */
export function shellFolderExpression(folder: string): string {
  if (folder === "~") return '"$HOME"';
  if (folder.startsWith("~/")) {
    return `"$HOME"/${shellEscape(folder.slice(2))}`;
  }
  return shellEscape(folder);
}

export async function normalizeWorkHost(
  workspaceId: string,
  input: { kind?: unknown; workFolder?: string; sshProfileAlias?: string },
): Promise<WorkHostInput> {
  if (input.kind === "local") throw new Error(NO_ATTACK_BOX_MESSAGE);
  if (input.kind !== "ssh") throw new Error("Work host must be ssh");
  const workFolder = validateWorkFolder(input.workFolder || defaultWorkFolder(workspaceId));

  const sshProfileAlias = String(input.sshProfileAlias || "").trim();
  if (!sshProfileAlias) throw new Error("SSH profile is required for a remote work host");
  const profile = await resolveSSHProfile(sshProfileAlias);
  if (!profile.summary.available) {
    throw new Error(profile.summary.error || "SSH profile is unavailable");
  }
  return { kind: "ssh", workFolder, sshProfileAlias };
}

export async function resolveWorkspaceWorkHost(workspaceId: string): Promise<ResolvedWorkHost> {
  const workspace = await WorkspaceModel.findOne({ workspaceId, status: "active" })
    .select("workspaceId workHost")
    .lean();
  if (!workspace) throw new Error("Workspace not found");

  return resolveWorkHostRecords(
    { workspaceId },
    { workspaceId: workspace.workspaceId, workHost: workspace.workHost },
  );
}

export async function resolveWorkHostRecords(
  session: { workspaceId?: string },
  workspace: { workspaceId: string; workHost?: { kind: WorkHostKind; workFolder: string; sshProfileAlias?: string } },
  profileResolver: typeof resolveSSHProfile = resolveSSHProfile,
): Promise<ResolvedWorkHost> {
  if (!session.workspaceId || session.workspaceId !== workspace.workspaceId) {
    throw new Error("Session does not belong to the resolved workspace");
  }
  const workspaceId = workspace.workspaceId;
  // A record saved before local execution was retired is treated as unset, so
  // the workspace falls back to the environment's attack box instead of the
  // backend.
  const stored = workspace.workHost?.kind === "ssh" ? workspace.workHost : undefined;
  const workFolder = validateWorkFolder(stored?.workFolder || defaultWorkFolder(workspaceId));

  const sshProfileAlias =
    stored?.sshProfileAlias || (hasLegacyConfig() ? LEGACY_PROFILE_ALIAS : undefined);
  if (!sshProfileAlias) throw new Error(NO_ATTACK_BOX_MESSAGE);
  const resolved = await profileResolver(sshProfileAlias);
  return {
    workspaceId,
    kind: "ssh",
    workFolder,
    sshProfileAlias,
    sshConfig: resolved.config,
    sshProfile: resolved.summary,
  };
}

export async function resolveSessionWorkHost(sessionId: string): Promise<ResolvedWorkHost> {
  const session = await SessionsModel.findOne({ sessionId, status: "active" })
    .select("workspaceId")
    .lean();
  if (!session?.workspaceId) throw new Error("Session workspace not found");
  const workspace = await WorkspaceModel.findOne({ workspaceId: session.workspaceId, status: "active" })
    .select("workspaceId workHost")
    .lean();
  if (!workspace) throw new Error("Workspace not found");
  return resolveWorkHostRecords(session, { workspaceId: workspace.workspaceId, workHost: workspace.workHost });
}

export function connectSSH(config: SSHConfig, timeoutMs = 10_000): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(ssh);
    };
    ssh.on("ready", () => finish());
    ssh.on("error", (error) => finish(error));
    ssh.on("keyboard-interactive", (_name, _instructions, _lang, prompts, done) => {
      done(prompts.map(() => config.password || ""));
    });
    ssh.connect({ ...config, readyTimeout: timeoutMs });
  });
}

export function execSSH(
  ssh: SSHClient,
  command: string,
  timeoutMs = 300_000,
  input?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, code = 0) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr, code });
    };
    ssh.exec(command, (error, stream) => {
      if (error) return finish(error);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          stream.destroy();
          finish(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      stream.on("close", (code: number | null) => finish(undefined, code ?? 0));
      stream.on("error", (streamError: Error) => finish(streamError));
      // Settle on exit-status instead of waiting for the channel 'close':
      // a backgrounded child (Xvnc, websockify, `sleep 60 &`) keeps the
      // channel's session alive on some sshd setups, so 'close' never fires
      // even though the command itself finished — the exec then hung until
      // the timeout. Exit-status arrives as soon as the remote shell exits;
      // a short grace window lets buffered stdout/stderr flush first.
      stream.on("exit", (code: number | null) => {
        setTimeout(() => finish(undefined, code ?? 0), 200);
      });
      // Written after the listeners are attached so an EPIPE from a command
      // that exits before reading stdin is observed, not thrown.
      if (typeof input === "string" && input.length > 0) {
        stream.stdin?.end(input);
      }
    });
  });
}

export async function testWorkHost(target: ResolvedWorkHost): Promise<CommandResult> {
  const marker = ".vulnpen-write-test";
  const folder = shellFolderExpression(target.workFolder);
  const command = `mkdir -p -- ${folder} && cd -- ${folder} && touch ${marker} && rm -f ${marker} && printf '%s' "$PWD"`;
  const ssh = await connectSSH(target.sshConfig!, 10_000);
  try {
    return await execSSH(ssh, command, 10_000);
  } finally {
    ssh.end();
  }
}

function directoryParent(currentPath: string): string | null {
  const parent = path.posix.dirname(currentPath);
  return parent === currentPath ? null : parent;
}

/**
 * List directories on a resolved workspace host without reading file contents.
 * Paths are validated and shell-escaped before remote execution; NUL separators
 * preserve spaces and other shell-significant characters in directory names.
 */
export async function listResolvedWorkHostDirectories(
  target: ResolvedWorkHost,
  requestedPath = "~",
): Promise<DirectoryListing> {
  const folder = validateWorkFolder(requestedPath || "~");
  const ssh = await connectSSH(target.sshConfig!, 10_000);
  try {
    const expression = shellFolderExpression(folder);
    const command =
      `printf '%s\\0' "$HOME" && ` +
      `cd -- ${expression} 2>/dev/null && ` +
      `printf '%s\\0' "$(pwd -P)" && ` +
      `find . -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null`;
    const result = await execSSH(ssh, command, 15_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Directory does not exist or is not accessible");
    const parts = result.stdout.split("\0");
    const homePath = parts.shift() || "/";
    const currentPath = parts.shift() || homePath;
    const directories = parts
      .filter(Boolean)
      .map((entry) => entry.startsWith("./") ? entry.slice(2) : entry)
      .filter(Boolean)
      .map((name) => ({ name, path: path.posix.join(currentPath, name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return {
      homePath,
      currentPath,
      parentPath: directoryParent(currentPath),
      directories,
    };
  } finally {
    ssh.end();
  }
}

export async function execOnWorkHost(
  sessionId: string,
  command: string,
  timeoutMs = 300_000,
  input?: string,
): Promise<CommandResult> {
  const target = await resolveSessionWorkHost(sessionId);
  return execOnResolvedWorkHost(target, command, timeoutMs, input);
}

/**
 * Prepended to every command run on a work host.
 *
 * Non-interactive SSH (`ssh host 'cmd'`) does not source ~/.bashrc or ~/.profile,
 * so tools installed under ~/.local/bin or ~/go/bin are invisible to the agent even
 * though they resolve fine in an interactive login shell. That applies to anything
 * installed without root — pipx, `go install`, and the AWS CLI's `-b ~/.local/bin`
 * mode all land there. Prepending (not appending) means a user-local build wins over
 * an older system copy of the same tool.
 */
const WORK_HOST_PATH_PREFIX = 'export PATH="$HOME/.local/bin:$HOME/go/bin:$PATH"';

export async function execOnResolvedWorkHost(
  target: ResolvedWorkHost,
  command: string,
  timeoutMs = 300_000,
  input?: string,
): Promise<CommandResult> {
  const folder = shellFolderExpression(target.workFolder);
  const inFolder =
    `${WORK_HOST_PATH_PREFIX}; mkdir -p -- ${folder} && cd -- ${folder} && ${command}`;
  const ssh = await connectSSH(target.sshConfig!);
  try {
    return await execSSH(ssh, inFolder, timeoutMs, input);
  } finally {
    ssh.end();
  }
}

/**
 * Removes everything inside the workspace work folder (the folder itself is kept,
 * since execOnResolvedWorkHost recreates it on every call).
 */
export async function purgeWorkFolder(target: ResolvedWorkHost, timeoutMs = 300_000): Promise<CommandResult> {
  return execOnResolvedWorkHost(
    target,
    "find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
    timeoutMs,
  );
}

/**
 * Compatibility adapter for older VNC setup code that only needs the small
 * `ssh2.Client` exec/event surface. Commands still route through the selected
 * workspace host, without duplicating transport decisions.
 */
export class WorkHostCommandClient extends EventEmitter {
  constructor(private readonly sessionId: string) {
    super();
  }

  connect(): this {
    queueMicrotask(() => this.emit("ready"));
    return this;
  }

  end(): this {
    return this;
  }

  exec(command: string, callback: (error: Error | undefined, stream: any) => void): void {
    const stdout = new PassThrough() as PassThrough & { stderr: PassThrough };
    stdout.stderr = new PassThrough();
    callback(undefined, stdout);
    execOnWorkHost(this.sessionId, command)
      .then((result) => {
        if (result.stdout) stdout.write(result.stdout);
        if (result.stderr) stdout.stderr.write(result.stderr);
        stdout.stderr.end();
        stdout.end();
        stdout.emit("close", result.code);
      })
      .catch((error) => {
        stdout.stderr.end();
        stdout.destroy(error);
      });
  }
}
