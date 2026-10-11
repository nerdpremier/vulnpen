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
 * MAGNITUDE_PROXY_URL to the egress fence, because the browser agent runs on
 * the attack box and the fence is the only way off that box.
 *
 * Reading `.env` raw made the pin invisible. Measured on a fenced deployment:
 * compose exported `http://egress:3128`, `.env` still carried the pre-fence
 * `http://kali:8080` (Burp), and the browser was launched at Burp — a listener
 * that has no route of its own, so every navigation died on Burp's own
 * "Unknown host" page while the fence answered the same URL with 200.
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
