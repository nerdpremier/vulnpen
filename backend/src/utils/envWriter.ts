import fs from "fs";
import dotenv from "dotenv";
import { getEnvFilePath, isDeploymentPinned, reloadEnv } from "./loadConfig";

/**
 * Escape a value for safe .env writing. Wraps in double quotes and escapes
 * backslashes, double quotes, and newlines so values with special chars
 * (e.g. [ ] # $ in passwords) are preserved correctly.
 */
function escapeEnvValue(value: string): string {
  if (value === undefined || value === null) return '""';
  const s = String(value);
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

export function readEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath();
  if (!fs.existsSync(envPath)) return {};

  const content = fs.readFileSync(envPath, "utf-8");
  const parsed = dotenv.parse(content);
  return parsed;
}

/**
 * Resolve a dynamic scalar setting (SSH, VNC, Burp, Magnitude) to the value
 * that actually applies.
 *
 * Two sources can carry the same setting and they disagree by design. The
 * Settings UI edits `.env`, and a change there is meant to take effect at once
 * — which is why these values are read from the file at the point of use
 * rather than captured at boot. The deployment, however, can pin a value by
 * exporting it as a container variable: `docker-compose.kali.yml` pins
 * SSH_HOST/SSH_PORT to the attack box's Compose service, because the address
 * the backend must dial differs from the host-facing value the `.env` carries.
 *
 * Reading `.env` raw made the pin invisible. Measured on a Compose deployment:
 * compose exported `SSH_HOST=kali`, `.env` still carried the host-facing
 * `127.0.0.1` / `4242`, and every SSH-dependent feature dialled loopback inside
 * the backend container — where nothing listens — and failed with ECONNREFUSED.
 *
 * Order, highest first:
 *   1. a value the deployment exported (see isDeploymentPinned);
 *   2. the `.env` the Settings UI writes — so a Settings change still applies
 *      immediately for every key the deployment did not pin;
 *   3. whatever loadConfig() installed in the process environment earlier.
 */
export function resolveDynamicSetting(key: string): string {
  if (isDeploymentPinned(key)) return process.env[key] ?? "";

  const fromFile = readEnvFile()[key];
  if (fromFile !== undefined) return fromFile;

  return process.env[key] ?? "";
}

export function writeEnvFile(vars: Record<string, string>): void {
  const envPath = getEnvFilePath();

  const lines: string[] = [
    "# ─── Dynamic Configuration (managed by backend API) ──────────────────",
    "",
  ];

  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${escapeEnvValue(value)}`);
  }

  lines.push("");
  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");

  reloadEnv();
}

export function updateEnvVars(updates: Record<string, string>): void {
  const current = readEnvFile();
  const merged = { ...current, ...updates };
  writeEnvFile(merged);
}

export function deleteEnvVars(keys: string[]): void {
  const current = readEnvFile();
  for (const key of keys) {
    delete current[key];
  }
  writeEnvFile(current);
}
