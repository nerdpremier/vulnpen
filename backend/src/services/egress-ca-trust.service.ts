/**
 * Distribute the egress fence's CA to everything that has to trust it.
 *
 * When the fence terminates TLS (`EGRESS_ALLOW_TLS=1`, `src/egressProxy.ts`), it
 * presents a certificate signed by its own CA — a CA no client knows. Every
 * HTTPS client on the attack box therefore has to be told to trust it, or each
 * one fails the handshake with an unknown-issuer error. Two clients matter, and
 * they read trust from two different stores:
 *
 *   - Chromium (the browser agent) reads the profile's NSS database. This is the
 *     same store and the same `certutil` dance `burp-ca.service.ts` already uses
 *     for Burp's CA; the two CAs are installed side by side under different
 *     nicknames.
 *   - `curl`, `python`, `nmap`, `sqlmap`, … read the OS trust store
 *     (`/etc/ssl/certs` via `update-ca-certificates`). Burp never needed this
 *     because Burp validates its own upstream TLS loosely; a plain client
 *     pointed at the fence over `HTTPS_PROXY` does not, so this step is new.
 *
 * The CA is read straight off `/kali-data/egress-ca/ca.crt` — the mount the
 * egress, backend and kali containers share — so there is no HTTP fetch here,
 * unlike Burp's CA. The private key is never read: this only ever installs the
 * public certificate.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { EGRESS_CA_DIR } from "../utils/egressCa";
import { getDataDir } from "../utils/loadConfig";
import { remoteBrowserEnabled, remoteBrowserHome } from "./remote-browser.service";
import { execSSHCommand } from "./ssh.service";

const execFileAsync = promisify(execFile);
const EGRESS_CA_NICKNAME = "VulnPen Egress Fence CA";
/** Where the OS trust store copy lands on the attack box. */
const ATTACK_BOX_CA_PATH = "/usr/local/share/ca-certificates/vulnpen-egress-ca.crt";

type EgressCaMetadata = {
  fingerprint: string;
  subject: string;
  validTo: string;
  installedAt: string;
};

export type EgressCaStatus = {
  /** The fence's CA has been generated (the fence has run with TLS on). */
  certificateAvailable: boolean;
  /** Chromium's profile store trusts it. */
  trustedByBrowser: boolean;
  /** The attack box's OS store trusts it (curl/python/nmap/sqlmap). */
  trustedByOs: boolean;
  trusted: boolean;
  needsRefresh: boolean;
  fingerprint?: string;
  subject?: string;
  validTo?: string;
  installedAt?: string;
  message: string;
};

function caDir(): string {
  return (process.env.EGRESS_CA_DIR ?? "").trim() || EGRESS_CA_DIR;
}

function certificatePath(): string {
  return path.join(caDir(), "ca.crt");
}

function getPaths() {
  const root = path.join(getDataDir(), "egress-ca");
  const browserHome = remoteBrowserEnabled()
    ? remoteBrowserHome()
    : path.join(getDataDir(), "chromium-home");
  return {
    root,
    browserHome,
    nssDb: path.join(browserHome, ".pki", "nssdb"),
    metadata: path.join(root, "metadata.json"),
  };
}

/** Is the fence's CA present on the shared mount yet? */
export function egressCaAvailable(): boolean {
  return fs.existsSync(certificatePath());
}

function readMetadata(): EgressCaMetadata | null {
  try {
    return JSON.parse(fs.readFileSync(getPaths().metadata, "utf8"));
  } catch {
    return null;
  }
}

function inspectCertificate(certificate: Buffer) {
  const x509 = new crypto.X509Certificate(certificate);
  if (!(x509 as crypto.X509Certificate & { ca?: boolean }).ca) {
    throw new Error("The egress fence CA is not a certificate authority.");
  }
  const now = Date.now();
  if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) {
    throw new Error("The egress fence CA is not currently valid.");
  }
  return {
    fingerprint: x509.fingerprint256,
    subject: x509.subject,
    validTo: x509.validTo,
  };
}

async function isTrustedInNss(): Promise<boolean> {
  const { nssDb } = getPaths();
  if (!fs.existsSync(path.join(nssDb, "cert9.db"))) return false;
  try {
    await execFileAsync("certutil", ["-d", `sql:${nssDb}`, "-L", "-n", EGRESS_CA_NICKNAME]);
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
    await execFileAsync("certutil", ["-d", `sql:${nssDb}`, "-N", "--empty-password"]);
  }

  try {
    await execFileAsync("certutil", ["-d", `sql:${nssDb}`, "-D", "-n", EGRESS_CA_NICKNAME]);
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
    EGRESS_CA_NICKNAME,
    "-i",
    certificatePath,
  ]);
}

/**
 * Install the CA into the attack box's OS trust store over SSH.
 *
 * Idempotent by construction: the copy overwrites the same path and
 * `update-ca-certificates` reconciles the bundle, so re-running it after a CA
 * rotation is the whole point rather than a hazard.
 */
async function installIntoOsTrustStore(certificatePath: string): Promise<void> {
  const command =
    `install -D -m 0644 ${certificatePath} ${ATTACK_BOX_CA_PATH} && ` +
    "update-ca-certificates";
  await execSSHCommand(command, 30_000);
}

/** Whether the attack box's OS store already carries this CA. */
async function isTrustedByOs(fingerprint?: string): Promise<boolean> {
  if (!fingerprint) return false;
  try {
    const remote = await execSSHCommand(
      `test -f ${ATTACK_BOX_CA_PATH} && openssl x509 -in ${ATTACK_BOX_CA_PATH} -noout -fingerprint -sha256`,
      15_000,
    );
    // openssl prints "SHA256 Fingerprint=AA:BB:…"; compare on the hex body.
    const remoteFingerprint = remote.split("=").pop()?.trim().toUpperCase().replace(/:/g, "");
    return remoteFingerprint === fingerprint.toUpperCase().replace(/:/g, "");
  } catch {
    return false;
  }
}

export async function getEgressCaStatus(): Promise<EgressCaStatus> {
  if (!egressCaAvailable()) {
    return {
      certificateAvailable: false,
      trustedByBrowser: false,
      trustedByOs: false,
      trusted: false,
      needsRefresh: false,
      message:
        "The egress fence has not generated its CA yet. Start it with EGRESS_ALLOW_TLS=1 to enable HTTPS interception.",
    };
  }

  const metadata = readMetadata();
  let certificate: Buffer;
  try {
    certificate = fs.readFileSync(certificatePath());
  } catch (error: any) {
    return {
      certificateAvailable: false,
      trustedByBrowser: false,
      trustedByOs: false,
      trusted: false,
      needsRefresh: false,
      message: `Could not read the egress fence CA: ${error?.message || error}`,
    };
  }

  let current: ReturnType<typeof inspectCertificate>;
  try {
    current = inspectCertificate(certificate);
  } catch (error: any) {
    return {
      certificateAvailable: false,
      trustedByBrowser: false,
      trustedByOs: false,
      trusted: false,
      needsRefresh: false,
      message: error?.message || "The egress fence CA is invalid.",
    };
  }

  const needsRefresh = !!metadata && metadata.fingerprint !== current.fingerprint;
  const trustedByBrowser = !!metadata && !needsRefresh && (await isTrustedInNss());
  const trustedByOs =
    !!metadata && !needsRefresh && (await isTrustedByOs(current.fingerprint));
  const trusted = trustedByBrowser && trustedByOs;

  return {
    certificateAvailable: true,
    trustedByBrowser,
    trustedByOs,
    trusted,
    needsRefresh,
    fingerprint: current.fingerprint,
    subject: current.subject,
    validTo: current.validTo,
    installedAt: metadata?.installedAt,
    message: trusted
      ? "Chromium and the attack box both trust the egress fence CA."
      : needsRefresh
        ? "The egress fence rotated its CA. Refresh trust to keep intercepting HTTPS."
        : "Trust the egress fence CA so HTTPS clients on the attack box accept its certificates.",
  };
}

export async function configureEgressCaTrust(): Promise<EgressCaStatus> {
  if (!egressCaAvailable()) {
    throw new Error(
      "The egress fence has not generated its CA yet. Start it with EGRESS_ALLOW_TLS=1 first.",
    );
  }

  const certificate = fs.readFileSync(certificatePath());
  const details = inspectCertificate(certificate);
  const paths = getPaths();
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });

  // The browser store and the OS store are independent, and either can fail on
  // its own (no attack box reachable for the SSH step, a missing certutil for
  // NSS). Neither failure should discard the other's success — the metadata is
  // written either way, and the caller reports the real per-store state, so a
  // half-installed CA is visible rather than retried forever behind an
  // exception.
  const temporary = `${path.join(paths.root, "egress-ca.crt")}.tmp`;
  fs.writeFileSync(temporary, certificate, { mode: 0o644 });
  const stored = path.join(paths.root, "egress-ca.crt");
  fs.renameSync(temporary, stored);

  const failures: string[] = [];
  try {
    await importIntoNss(stored);
  } catch (error: any) {
    failures.push(`browser: ${error?.message || error}`);
  }
  try {
    await installIntoOsTrustStore(stored);
  } catch (error: any) {
    failures.push(`os: ${error?.message || error}`);
  }

  const metadata: EgressCaMetadata = {
    ...details,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.metadata, JSON.stringify(metadata, null, 2), { mode: 0o600 });

  const status = await getEgressCaStatus();
  if (failures.length && !status.trusted) {
    throw new Error(`Could not install the egress fence CA (${failures.join("; ")})`);
  }
  return status;
}

const EGRESS_CA_WATCH_INTERVAL_MS = 30_000;

/**
 * Whether trust should be (re)installed without being asked. Only a genuinely
 * actionable state qualifies: the CA must exist, have been read successfully,
 * and not already be trusted by both stores. `needsRefresh` is deliberately not
 * required, so the very first run installs it too.
 */
export function shouldAutoTrustEgressCa(status: EgressCaStatus): boolean {
  return status.certificateAvailable && !status.trusted;
}

/**
 * Poll the fence's CA and keep the attack box's clients in step. Returns a stop
 * function; the interval is unref'd so it never holds the process open.
 *
 * The CA only changes if the operator deletes it (it is persisted on
 * /kali-data), so this mostly runs to notice the very first generation and any
 * later rotation, and repeats of the same failure are reported once.
 */
export function startEgressCaWatcher(
  intervalMs: number = EGRESS_CA_WATCH_INTERVAL_MS,
): () => void {
  let inFlight = false;
  let lastReported = "";

  const report = (detail: string): void => {
    if (detail === lastReported) return;
    lastReported = detail;
    console.warn(`[egress-ca] ${detail}`);
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const status = await getEgressCaStatus();
      if (!shouldAutoTrustEgressCa(status)) return;

      const rotated = status.needsRefresh;
      const next = await configureEgressCaTrust();
      if (next.trusted) {
        lastReported = "";
        console.log(
          `[egress-ca] ${rotated ? "The fence rotated its CA" : "Egress fence CA installed"}; ` +
            `trust refreshed (${next.fingerprint})`,
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
