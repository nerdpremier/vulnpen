/**
 * The egress fence's own CA.
 *
 * TLS interception means the fence stands between the client and the real
 * destination: it has to present a certificate for whatever host the client
 * asked to CONNECT to, signed by something the client is made to trust. This
 * generates that CA once and persists it so every attack-box tool keeps
 * trusting the same one across restarts, then signs a leaf certificate for
 * each destination host on demand.
 *
 * The CA's private key never leaves this process — it lives on the same
 * bind mount `backend` and `kali` already share (`/kali-data`), but nothing
 * outside `egressProxy.ts` needs it: `egress-ca-trust.service.ts` only ever
 * reads the public certificate, to install trust, never the key.
 *
 * node-forge carries an unpatched high advisory (GHSA-86w9-cpqp-85rv): RSA
 * PKCS#1 v1.5 signature *verification* accepts extra nested DigestAlgorithm
 * elements. Only verification is affected, and this module never verifies a
 * signature — it generates keys, builds certificates and signs them, so the
 * vulnerable path is unreachable here. Upstream verification of the real
 * destination is Node's own TLS stack (`rejectUnauthorized`), and the client
 * side trusts the CA through the OS/NSS stores, not through forge. With no
 * fixed release to move to, the finding is recorded in `pnpm.auditConfig`
 * rather than left to fail the audit gate for every other package.
 */
import fs from "fs";
import path from "path";
import forge from "node-forge";

const CA_SUBJECT = "VulnPen Egress Fence CA";
const CA_VALIDITY_YEARS = 10;
const LEAF_VALIDITY_YEARS = 1;
const KEY_BITS = 2048;

/**
 * Where the fence keeps its CA. `/kali-data` is the bind mount the egress,
 * backend and kali containers all share at the same path, so the backend's
 * trust installer can read the public certificate straight off disk while the
 * private key stays inside the fence process. Keep in sync with the
 * `EGRESS_CA_DIR` override the egress container can set via env.
 */
export const EGRESS_CA_DIR = "/kali-data/egress-ca";

export interface CaPair {
  certPem: string;
  keyPem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.PrivateKey;
}

export interface LeafPair {
  cert: string;
  key: string;
}

function randomSerial(): string {
  // forge requires a hex string with no leading byte >= 0x80 (would be read
  // as a negative ASN.1 integer) — prefix a zero nibble-pair to stay positive.
  return "00" + forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function buildCaCertificate(): CaPair {
  const keys = forge.pki.rsa.generateKeyPair(KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + CA_VALIDITY_YEARS,
  );

  const attrs = [{ name: "commonName", value: CA_SUBJECT }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    cert,
    key: keys.privateKey,
  };
}

/** Load the CA persisted at `caDir`, or generate and persist a new one. */
export function loadOrCreateCa(caDir: string): CaPair {
  const certPath = path.join(caDir, "ca.crt");
  const keyPath = path.join(caDir, "ca.key");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const certPem = fs.readFileSync(certPath, "utf8");
    const keyPem = fs.readFileSync(keyPath, "utf8");
    return {
      certPem,
      keyPem,
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
    };
  }

  const ca = buildCaCertificate();
  fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });
  const tmpCert = `${certPath}.tmp`;
  const tmpKey = `${keyPath}.tmp`;
  fs.writeFileSync(tmpCert, ca.certPem, { mode: 0o644 });
  fs.writeFileSync(tmpKey, ca.keyPem, { mode: 0o600 });
  fs.renameSync(tmpCert, certPath);
  fs.renameSync(tmpKey, keyPath);
  return ca;
}

/**
 * Sign a leaf certificate for `host`, caching by hostname so a repeat
 * CONNECT to the same destination does not re-run RSA key generation.
 */
export function createLeafSigner(ca: CaPair): (host: string) => LeafPair {
  const cache = new Map<string, LeafPair>();

  return (host: string): LeafPair => {
    const cached = cache.get(host);
    if (cached) return cached;

    const keys = forge.pki.rsa.generateKeyPair(KEY_BITS);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + LEAF_VALIDITY_YEARS,
    );

    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: "extKeyUsage", serverAuth: true },
      {
        // An address literal needs an iPAddress SAN (type 7): a DNS SAN holding
        // "10.0.0.5" is a different name and no client matches it against the
        // address it dialled. In-scope targets are routinely bare addresses.
        name: "subjectAltName",
        altNames: [ipLiteral(host) ? { type: 7, ip: host } : { type: 2, value: host }],
      },
    ]);
    cert.sign(ca.key, forge.md.sha256.create());

    const pair: LeafPair = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };
    cache.set(host, pair);
    return pair;
  };
}

/** True for an IPv4 or IPv6 literal (the `[...]` form is already stripped). */
function ipLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[0-9a-f:]+$/i.test(host) && host.includes(":");
}

/** The CA certificate as DER, for serving to clients that need to install it. */
export function caCertificateDer(ca: CaPair): Buffer {
  const asn1 = forge.pki.certificateToAsn1(ca.cert);
  const der = forge.asn1.toDer(asn1).getBytes();
  return Buffer.from(der, "binary");
}
