/**
 * Live check for the REMOTE browser path: Chromium on the attack box.
 *
 * The browser the agent drives does not run in the backend container — it runs
 * on the attack box, so it shares that box's route to the target (the VPN
 * connected there). This check proves each link of the chain that makes that
 * work, in order:
 *
 *   1. SSH to the attack box
 *   2. launch Chromium there with CDP on its loopback
 *   3. open a loopback-only SSH port-forward to that port
 *   4. attach Playwright over CDP
 *   5. drive the page through the DOM
 *
 * It uses a local `data:` page, so it needs no network and no model provider.
 *
 * Run: npx tsx scripts/browser-remote-check.ts
 */
import { loadConfig } from "../src/utils/loadConfig";
import { resolveDynamicSetting } from "../src/utils/envWriter";
import { buildSSHConfig } from "../src/utils/sshConfig";
import { execSSHCommand } from "../src/services/ssh.service";
import {
  connectRemoteBrowser,
  killRemoteChromium,
  launchRemoteChromium,
  openBrowserTunnel,
  proxyUrlForAttackBox,
  remoteBrowserEnabled,
  remoteBrowserHome,
  remoteCdpPort,
  waitForCdp,
} from "../src/services/remote-browser.service";
import { snapshotPage, runDomAction } from "../src/services/dom-browser.service";

/** A page with the control shapes the DOM path has to handle. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Remote check</title></head>
<body>
  <h1>Sign in</h1>
  <form onsubmit="event.preventDefault(); document.getElementById('out').textContent =
      'submitted:' + document.getElementById('user').value;">
    <label for="user">Username</label>
    <input id="user" name="user" type="text" placeholder="your username" />
    <button type="submit">Sign in</button>
  </form>
  <p id="out"></p>
</body></html>`;

async function main(): Promise<void> {
  loadConfig();

  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  const ssh = buildSSHConfig();
  const port = remoteCdpPort();
  const home = remoteBrowserHome();
  // Through resolveDynamicSetting, the same way the tool resolves it: a check
  // that reads `.env` directly would launch a different proxy than production
  // and report PASS for a browser the agent never gets.
  const proxyUrl = resolveDynamicSetting("MAGNITUDE_PROXY_URL");
  // The value that is actually launched with. The rewrite has to happen here,
  // not just in the line below: `kali:8080` means "Burp, next door" from the
  // backend, but from the attack box it is that box itself, so launching the
  // raw value only works by accident and the printed line would be a lie.
  const launchedProxy = proxyUrlForAttackBox(proxyUrl);

  console.log("\n=== Remote browser path check (Chromium on the attack box) ===");
  console.log(`  ssh        ${ssh.username}@${ssh.host}:${ssh.port}`);
  console.log(`  cdp port   ${port}`);
  console.log(`  profile    ${home}`);
  console.log(`  proxy      ${proxyUrl || "(none)"} -> ${launchedProxy || "(none)"}`);
  console.log("");

  check("the browser is configured to run on the attack box", remoteBrowserEnabled());
  if (!remoteBrowserEnabled()) {
    console.log("\nverdict: FAIL (BROWSER_AGENT_REMOTE is off)");
    process.exitCode = 1;
    return;
  }

  let tunnel: { localPort: number; close(): void } | null = null;

  try {
    // 1. SSH.
    const whoami = (await execSSHCommand("echo SSH_OK", 15_000)).trim();
    check("the attack box answers over SSH", whoami.includes("SSH_OK"), whoami);

    // 2. Launch there.
    await launchRemoteChromium({ proxyUrl: launchedProxy });
    const ps = await execSSHCommand(
      `pgrep -f '[r]emote-debugging-port=${port}' | head -1`,
      10_000,
    );
    const pid = ps.trim().split("\n")[0] || "";
    check("Chromium is running on the attack box", /^\d+$/.test(pid), `pid ${pid || "none"}`);

    // It has to be on the desktop display, or the operator cannot watch it —
    // which is half the reason it runs there at all.
    if (pid) {
      const display = await execSSHCommand(
        `tr '\\0' '\\n' < /proc/${pid}/environ | sed -n 's/^DISPLAY=//p'`,
        10_000,
      );
      check(
        "Chromium draws on the attack box's desktop display",
        /^:\d+/.test(display.trim()),
        display.trim() || "(DISPLAY unset)",
      );
    }

    // 3. Tunnel.
    tunnel = await openBrowserTunnel(port);
    check("an SSH tunnel to the CDP port is open", tunnel.localPort > 0, `127.0.0.1:${tunnel.localPort}`);

    // 4. Attach.
    await waitForCdp(tunnel.localPort);
    check("the CDP endpoint answers through the tunnel", true);
    const { browser, page } = await connectRemoteBrowser(tunnel.localPort);
    check("Playwright attached over CDP", !!browser && !!page);

    // 5. Drive it through the DOM, exactly as the browser_action tool does.
    await page.goto("data:text/html," + encodeURIComponent(PAGE), {
      waitUntil: "domcontentloaded",
    });
    const snap = await snapshotPage(page, 2000);
    check("the page reads back as DOM", snap.elements.length > 0, `${snap.elements.length} elements`);

    const field = snap.elements.find((e) => e.role === "textbox");
    const button = snap.elements.find((e) => e.role === "button");
    check("the DOM snapshot indexed the controls", !!field && !!button);

    if (field && button) {
      await runDomAction(page, { action: "fill", element_id: field.id, value: "operator" }, snap.elements);
      await runDomAction(page, { action: "click", element_id: button.id }, snap.elements);
      const out = await page.evaluate(
        () => (document.getElementById("out") as HTMLElement)?.textContent ?? "",
      );
      check("a DOM fill + click reached the page", out === "submitted:operator", out || "(empty)");
    }

    // 6. Stop it exactly the way production stops it, then prove it is gone.
    // The assertion used to be a bare `true`, which is why a real defect hid
    // here: browser.close() over CDP does NOT terminate the remote browser, so
    // the process was still on the attack box after every "clean" close. The
    // kill is part of the stop path, not a spare tyre, so it is exercised here.
    await browser.close();
    await killRemoteChromium(port);
    const stillThere = (
      await execSSHCommand(`pgrep -f '[r]emote-debugging-port=${port}' | head -1`, 10_000)
    ).trim();
    check(
      "the browser is gone from the attack box after stop",
      !stillThere,
      stillThere ? `pid ${stillThere} survived` : "no process left",
    );
  } catch (error: any) {
    check("the remote browser chain completed", false, error?.message ?? String(error));
    await killRemoteChromium(port);
  } finally {
    tunnel?.close();
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
