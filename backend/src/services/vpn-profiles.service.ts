import fs from "fs";
import path from "path";
import { KALI_DATA_DIR } from "../config/constants";

export const VPN_DIR = path.join(KALI_DATA_DIR, "vpn-profiles");

export interface VpnProfile {
  name: string;
  filename: string;
  path: string;
  assetDir: string;
  size: number;
}

function ensureVPNDir(): void {
  if (!fs.existsSync(VPN_DIR)) {
    fs.mkdirSync(VPN_DIR, { recursive: true });
  }
}

/** Filesystem-safe profile key. Everything keyed off a profile name goes through here. */
export function sanitizeProfileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").substring(0, 64);
}

export function listLocalProfiles(): VpnProfile[] {
  ensureVPNDir();
  const files = fs
    .readdirSync(VPN_DIR)
    .filter((f: string) => f.endsWith(".ovpn") || f.endsWith(".conf"));
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

export function findProfile(name: string): VpnProfile | undefined {
  const safeName = sanitizeProfileName(name);
  return listLocalProfiles().find((p) => p.name === safeName);
}

/**
 * Store an uploaded profile plus its asset bundle. Replaces any existing
 * profile with the same name (either extension) and its assets. Returns the
 * stored profile descriptor, or a validation error message.
 */
export function saveProfile(input: {
  profileName?: string;
  originalName: string;
  profileBuffer: Buffer;
  assets: Array<{ originalname: string; buffer: Buffer }>;
}): { profile: { name: string; filename: string; assets: number } } | { error: string } {
  const ext = /\.conf$/i.test(input.originalName) ? ".conf" : ".ovpn";
  const safeName = sanitizeProfileName(
    input.profileName || input.originalName.replace(/\.(ovpn|conf)$/i, ""),
  );
  if (!safeName) {
    return { error: "VPN profile name is invalid" };
  }

  ensureVPNDir();
  const filename = safeName + ext;
  const filePath = path.join(VPN_DIR, filename);

  fs.rmSync(path.join(VPN_DIR, safeName + (ext === ".ovpn" ? ".conf" : ".ovpn")), { force: true });
  fs.writeFileSync(filePath, input.profileBuffer, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);

  const assetDir = path.join(VPN_DIR, `${safeName}.files`);
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.mkdirSync(assetDir, { recursive: true });

  const assetNames = new Set<string>();
  for (const asset of input.assets) {
    const assetName = path.basename(asset.originalname);
    if (assetNames.has(assetName)) {
      fs.rmSync(assetDir, { recursive: true, force: true });
      fs.rmSync(filePath, { force: true });
      return { error: `Duplicate VPN bundle filename: ${assetName}` };
    }
    assetNames.add(assetName);
    fs.writeFileSync(path.join(assetDir, assetName), asset.buffer, { mode: 0o600 });
  }

  return { profile: { name: safeName, filename, assets: input.assets.length } };
}

export function deleteProfile(name: string): "deleted" | "not_found" {
  const profile = findProfile(name);
  if (!profile) return "not_found";
  fs.unlinkSync(profile.path);
  fs.rmSync(profile.assetDir, { recursive: true, force: true });
  return "deleted";
}

/** Interactive auth-user-pass profiles cannot be driven by the connect flow. */
export function requiresInteractiveAuth(profilePath: string): boolean {
  const content = fs.readFileSync(profilePath, "utf8");
  return /^\s*auth-user-pass\s*(?:#.*)?$/m.test(content);
}
