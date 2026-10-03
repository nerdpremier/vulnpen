import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDataDir } from "../utils/loadConfig";
import { readEnvFile } from "../utils/envWriter";

const execFileAsync = promisify(execFile);
const BURP_CA_URL = "http://burpsuite/cert";
const BURP_CA_NICKNAME = "VulnPen Burp CA";

type BurpCaMetadata = {
  fingerprint: string;
  subject: string;
  validTo: string;
  installedAt: string;
};

export type BurpCaStatus = {
  proxyConfigured: boolean;
  certificateAvailable: boolean;
  trusted: boolean;
  needsRefresh: boolean;
  fingerprint?: string;
  subject?: string;
  validTo?: string;
  installedAt?: string;
  message: string;
};

function getPaths() {
  const root = path.join(getDataDir(), "burp-ca");
  const browserHome = path.join(getDataDir(), "chromium-home");
  return {
    root,
    browserHome,
    nssDb: path.join(browserHome, ".pki", "nssdb"),
    certificate: path.join(root, "burp-ca.der"),
    metadata: path.join(root, "metadata.json"),
  };
}

export function getBurpBrowserHome(): string {
  return getPaths().browserHome;
}

function proxyUrlFromConfig(): string {
  return readEnvFile().MAGNITUDE_PROXY_URL?.trim() || "";
}

function readMetadata(): BurpCaMetadata | null {
  try {
    return JSON.parse(fs.readFileSync(getPaths().metadata, "utf8"));
  } catch {
    return null;
  }
}

function fetchCertificate(proxyUrl: string): Promise<Buffer> {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") {
    throw new Error(
      "The Browser Agent proxy must use http:// for automatic Burp CA setup.",
    );
  }

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: "application/octet-stream",
      Host: "burpsuite",
    };

    if (proxy.username || proxy.password) {
      const username = decodeURIComponent(proxy.username);
      const password = decodeURIComponent(proxy.password);
      headers["Proxy-Authorization"] =
        `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }

    const request = http.request(
      {
        hostname: proxy.hostname,
        port: proxy.port || "80",
        method: "GET",
        path: BURP_CA_URL,
        headers,
        timeout: 10_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Burp returned HTTP ${response.statusCode || "unknown"} while exporting its CA.`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            request.destroy(
              new Error("Burp CA response exceeded the 1 MB safety limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );

    request.on("timeout", () =>
      request.destroy(new Error("Timed out while downloading the Burp CA.")),
    );
    request.on("error", reject);
    request.end();
  });
}

function inspectCertificate(certificate: Buffer) {
  try {
    const x509 = new crypto.X509Certificate(certificate);
    if (!(x509 as crypto.X509Certificate & { ca?: boolean }).ca) {
      throw new Error(
        "The downloaded certificate is not a certificate authority.",
      );
    }
    const now = Date.now();
    if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) {
      throw new Error("The Burp CA certificate is not currently valid.");
    }
    return {
      fingerprint: x509.fingerprint256,
      subject: x509.subject,
      validTo: x509.validTo,
    };
  } catch (error: any) {
    if (error?.message?.startsWith("The ")) throw error;
    throw new Error("Burp returned an invalid CA certificate.");
  }
}

async function isTrustedInNss(): Promise<boolean> {
  const { nssDb } = getPaths();
  if (!fs.existsSync(path.join(nssDb, "cert9.db"))) return false;

  try {
    await execFileAsync("certutil", [
      "-d",
      `sql:${nssDb}`,
      "-L",
      "-n",
      BURP_CA_NICKNAME,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function importIntoNss(certificatePath: string): Promise<void> {
  const { nssDb } = getPaths();
  fs.mkdirSync(nssDb, { recursive: true, mode: 0o700 });

  try {
    await execFileAsync("certutil", ["-H"]);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Chromium certificate tools are unavailable. Rebuild the backend container and retry.",
      );
    }
  }

  if (!fs.existsSync(path.join(nssDb, "cert9.db"))) {
    await execFileAsync("certutil", [
      "-d",
      `sql:${nssDb}`,
      "-N",
      "--empty-password",
    ]);
  }

  try {
    await execFileAsync("certutil", [
      "-d",
      `sql:${nssDb}`,
      "-D",
      "-n",
      BURP_CA_NICKNAME,
    ]);
  } catch {
    // The first setup has no existing certificate to remove.
  }

  await execFileAsync("certutil", [
    "-d",
    `sql:${nssDb}`,
    "-A",
    "-t",
    "C,,",
    "-n",
    BURP_CA_NICKNAME,
    "-i",
    certificatePath,
  ]);
}

export async function getBurpCaStatus(): Promise<BurpCaStatus> {
  const proxyUrl = proxyUrlFromConfig();
  if (!proxyUrl) {
    return {
      proxyConfigured: false,
      certificateAvailable: false,
      trusted: false,
      needsRefresh: false,
      message:
        "Set the Browser Agent proxy URL to the Burp proxy listener first.",
    };
  }

  const metadata = readMetadata();
  const trustedInNss = metadata ? await isTrustedInNss() : false;

  try {
    const current = inspectCertificate(await fetchCertificate(proxyUrl));
    const needsRefresh =
      !!metadata && metadata.fingerprint !== current.fingerprint;
    const trusted = trustedInNss && !needsRefresh;

    return {
      proxyConfigured: true,
      certificateAvailable: true,
      trusted,
      needsRefresh,
      fingerprint: current.fingerprint,
      subject: current.subject,
      validTo: current.validTo,
      installedAt: metadata?.installedAt,
      message: trusted
        ? "Chromium trusts the CA currently used by Burp."
        : needsRefresh
          ? "Burp is using a new CA. Refresh Chromium trust to continue intercepting HTTPS."
          : "Burp is connected. Trust its CA to enable reliable HTTPS interception.",
    };
  } catch (error: any) {
    return {
      proxyConfigured: true,
      certificateAvailable: false,
      trusted: false,
      needsRefresh: false,
      fingerprint: metadata?.fingerprint,
      subject: metadata?.subject,
      validTo: metadata?.validTo,
      installedAt: metadata?.installedAt,
      message:
        error?.message ||
        "Could not download the Burp CA from its proxy listener.",
    };
  }
}

export async function configureBurpCaTrust(): Promise<BurpCaStatus> {
  const proxyUrl = proxyUrlFromConfig();
  if (!proxyUrl) {
    throw new Error(
      "Set the Browser Agent proxy URL to the Burp proxy listener first.",
    );
  }

  const certificate = await fetchCertificate(proxyUrl);
  const details = inspectCertificate(certificate);
  const paths = getPaths();
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });

  const temporaryCertificate = `${paths.certificate}.tmp`;
  fs.writeFileSync(temporaryCertificate, certificate, { mode: 0o644 });
  fs.renameSync(temporaryCertificate, paths.certificate);
  await importIntoNss(paths.certificate);

  const metadata: BurpCaMetadata = {
    ...details,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.metadata, JSON.stringify(metadata, null, 2), {
    mode: 0o600,
  });

  return getBurpCaStatus();
}

const BURP_CA_WATCH_INTERVAL_MS = 30_000;

/**
 * Whether the Browser Agent profile should pick up Burp's current CA without
 * being asked. Burp mints a new CA whenever it starts a fresh project, and the
 * bundled Kali autostart opens one on every container start, so the trusted
 * copy goes stale by itself. A stale trust is invisible until a request fails,
 * which is why this runs on its own instead of waiting for the panel button.
 *
 * Only a genuinely actionable state qualifies: the proxy URL must be set, the
 * certificate must have been fetched successfully, and the profile must not
 * already trust it. needsRefresh is deliberately not required so the very
 * first run installs the CA too.
 */
export function shouldAutoTrustBurpCa(status: BurpCaStatus): boolean {
  return status.proxyConfigured && status.certificateAvailable && !status.trusted;
}

/**
 * Poll Burp's CA and keep the Browser Agent profile in step. Returns a stop
 * function; the interval is unref'd so it never holds the process open.
 *
 * Repeats of the same failure are reported once, so a Burp that is simply not
 * running yet cannot flood the log every interval.
 */
export function startBurpCaWatcher(
  intervalMs: number = BURP_CA_WATCH_INTERVAL_MS,
): () => void {
  let inFlight = false;
  let lastReported = "";

  const report = (detail: string): void => {
    if (detail === lastReported) return;
    lastReported = detail;
    console.warn(`[burp-ca] ${detail}`);
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const status = await getBurpCaStatus();
      if (!shouldAutoTrustBurpCa(status)) return;

      const rotated = status.needsRefresh;
      const next = await configureBurpCaTrust();
      if (next.trusted) {
        lastReported = "";
        console.log(
          `[burp-ca] ${rotated ? "Burp rotated its CA" : "Burp CA installed"}; ` +
            `Chromium trust refreshed (${next.fingerprint})`,
        );
        return;
      }
      report(`auto-refresh incomplete: ${next.message}`);
    } catch (error: any) {
      report(`auto-refresh failed: ${error?.message || error}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick();

  return () => clearInterval(timer);
}
