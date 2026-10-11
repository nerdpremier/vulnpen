/**
 * Verify the Burp CA really reaches the REMOTE browser's trust store.
 *
 * The CA is installed by the backend into $HOME/.pki/nssdb on the shared
 * /kali-data mount, and the remote Chromium is launched with HOME pointing at
 * that same directory. This checks each link: the CA is fetchable, certutil
 * writes it into the NSS db, and the browser on the attack box then sees a
 * server certificate signed by Burp as TRUSTED rather than as an error.
 *
 * Run: npx tsx scripts/burp-ca-check.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import {
  configureBurpCaTrust,
  getBurpBrowserHome,
  getBurpCaStatus,
} from "../src/services/burp-ca.service";
import {
  connectRemoteBrowser,
  killRemoteChromium,
  launchRemoteChromium,
  openBrowserTunnel,
  proxyUrlForAttackBox,
  remoteBrowserDisplay,
  remoteBrowserHome,
  remoteCdpPort,
  waitForCdp,
} from "../src/services/remote-browser.service";
import { readEnvFile } from "../src/utils/envWriter";
import { loadConfig } from "../src/utils/loadConfig";

const execFileAsync = promisify(execFile);

const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function main() {
  // The SSH settings and the proxy URL come from the .env the app reads, not
  // from the process environment, so they have to be loaded the same way the
  // running server loads them.
  loadConfig();

  const nssDb = path.join(getBurpBrowserHome(), ".pki", "nssdb");
  const port = remoteCdpPort();

  console.log("\n=== Burp CA -> remote browser trust store ===");
  console.log(`  browser HOME  ${getBurpBrowserHome()}`);
  console.log(`  NSS db        ${nssDb}`);
  console.log("");

  // 1. Fetch + import, through the service the endpoint calls.
  let status: any = null;
  try {
    status = await configureBurpCaTrust();
  } catch (error: any) {
    check("the Burp CA can be fetched and installed", false, error?.message ?? String(error));
    console.log(`\nverdict: FAIL (${failures.length} failed)`);
    process.exitCode = 1;
    return;
  }
  check("the Burp CA can be fetched and installed", status?.trusted === true, JSON.stringify(status));

  // 2. It really landed in the shared NSS db the remote browser will read.
  check("cert9.db exists in the browser's own NSS store", fs.existsSync(path.join(nssDb, "cert9.db")));
  const { stdout: listed } = await execFileAsync("certutil", [
    "-d",
    `sql:${nssDb}`,
    "-L",
  ]);
  check(
    "the CA is listed in the NSS db",
    listed.includes("VulnPen Burp CA"),
    listed.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" | "),
  );

  // 3. The status the UI reads agrees.
  const reread = await getBurpCaStatus();
  check("getBurpCaStatus reports it trusted", reread.trusted === true, JSON.stringify(reread));

  // 4. The browser on the attack box, launched the way production launches it,
  //    must treat a Burp-signed leaf as trusted. Ask Chromium itself rather than
  //    trusting that "the file is there" means "the browser trusts it".
  const proxyUrl = proxyUrlForAttackBox(readEnvFile().MAGNITUDE_PROXY_URL || "");
  await launchRemoteChromium({
    proxyUrl,
    display: remoteBrowserDisplay(),
    home: remoteBrowserHome(),
  });
  const tunnel = await openBrowserTunnel(port);
  try {
    await waitForCdp(tunnel.localPort);
    const { browser, page } = await connectRemoteBrowser(tunnel.localPort);

    // securityState on the CDP side reports the browser's verdict on the TLS
    // chain. Anything other than "secure" means the CA was NOT trusted.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    // The cache has to be off, or a page fetched on an earlier run is served
    // from disk and the request never reaches the proxy — the check would pass
    // while proving nothing about the proxy at all. That is exactly how a broken
    // `--proxy-server` value stayed hidden through several "passing" runs.
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    let certError = "";
    cdp.on("Network.loadingFailed", (event: any) => {
      if (event?.errorText) certError = String(event.errorText);
    });
    // Who signed the certificate the browser accepted. Burp re-signs every
    // intercepted leaf, so seeing PortSwigger here proves the traffic really
    // went through the proxy rather than straight out.
    let issuer = "";
    cdp.on("Network.responseReceived", (event: any) => {
      const details = event?.response?.securityDetails;
      if (details?.issuer) issuer = String(details.issuer);
    });

    let navError = "";
    try {
      // A cache-busting parameter as well: belt and braces against any
      // intermediate cache this browser might still consult.
      await page.goto(`https://example.com/?vulnpen-check=${Date.now()}`, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    } catch (error: any) {
      navError = error?.message?.split("\n")[0] ?? String(error);
    }

    check(
      "the remote Chromium loads an HTTPS page through Burp",
      !navError && !certError,
      navError || certError || "loaded",
    );
    check(
      "the page was served through Burp's TLS interception",
      /portswigger/i.test(issuer),
      issuer || "(no security details reported)",
    );

    await browser.close();
    await killRemoteChromium(port);
  } finally {
    tunnel.close();
  }

  console.log(
    `\nverdict: ${failures.length ? `FAIL (${failures.length} failed)` : "PASS (0 failed)"}`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
