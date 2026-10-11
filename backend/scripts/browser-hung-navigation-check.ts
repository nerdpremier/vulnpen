/**
 * Live check for a click whose follow-up navigation never commits.
 *
 * The defect this proves fixed, seen against the engagement target: the agent
 * clicked a submit button, the server accepted the connection and never
 * answered, and the run ended with
 *
 *   Browser action failed: locator.click: Timeout 15000ms exceeded.
 *     - click action done
 *     - waiting for scheduled navigations to finish
 *
 * Two things were wrong with that. The click *had* been delivered — Playwright
 * logs `action done` only after the event is sent — so the action was reported
 * as failed when it had happened, and the model was invited to send it again,
 * which on a form is a second submission. And the message carried the
 * proxy/VPN hint, sending the operator to a setting that had nothing to do
 * with it: the page had been reached, and its form had been submitted.
 *
 * The reproduction is deliberately the real thing, not a simulated error
 * string: a page served from the attack box whose form posts to a port that
 * accepts the connection and then says nothing, which is what a hung target
 * does. The raw Playwright click is run first as a positive control — if it
 * does not hang, the fixture is not reproducing anything and the rest of the
 * check proves nothing.
 *
 * The browser is launched with no proxy, so the check needs neither Burp nor
 * the network: what is being measured is the driver's post-click wait, and a
 * proxy in the path would only add a way for it to fail for other reasons.
 *
 * Run: npx tsx scripts/browser-hung-navigation-check.ts
 */
import { loadConfig } from "../src/utils/loadConfig";
import { buildSSHConfig } from "../src/utils/sshConfig";
import { execSSHCommand } from "../src/services/ssh.service";
import {
  connectRemoteBrowser,
  killRemoteChromium,
  launchRemoteChromium,
  openBrowserTunnel,
  remoteBrowserEnabled,
  remoteCdpPort,
  waitForCdp,
} from "../src/services/remote-browser.service";
import { runDomAction } from "../src/services/dom-browser.service";
import {
  browserReachabilityHint,
  isPostActionNavigationTimeout,
} from "../src/utils/magnitudeError";

/** Where the fixture listens on the attack box. */
const PAGE_PORT = 8098;
const HANG_PORT = 8099;

/** How long the click is given. Short: the fixture never answers, by design. */
const CLICK_TIMEOUT_MS = 5_000;

/**
 * The fixture, run on the attack box.
 *
 * Two listeners: one serves the form, one accepts and then never answers. The
 * accepted sockets are held open in a list, because a socket that falls out of
 * scope is collected and closed — which would turn the hang into a reset and
 * make the fixture quietly stop reproducing the case.
 */
const FIXTURE = `
import socket, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

FORM = b"""<!doctype html><html><head><meta charset="utf-8"><title>Hung navigation</title></head>
<body><h1>Sign in</h1>
<form action="http://127.0.0.1:${HANG_PORT}/" method="get">
<label for="user">Username</label><input id="user" name="user" type="text" placeholder="your username"/>
<button type="submit">Sign in</button></form></body></html>"""

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(FORM)))
        self.end_headers()
        self.wfile.write(FORM)
    def log_message(self, *a):
        pass

held = []

def hang():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", ${HANG_PORT}))
    s.listen(16)
    while True:
        c, _ = s.accept()
        held.append(c)

threading.Thread(target=hang, daemon=True).start()
HTTPServer(("127.0.0.1", ${PAGE_PORT}), H).serve_forever()
`;

/**
 * Is the page unreadable right now?
 *
 * `page.url()` is not a useful probe — it needs no execution context and answers
 * even while everything else blocks. `page.title()` does need one, so it is the
 * one that reports the wedge.
 */
async function readHangs(page: any, ms = 3_000): Promise<boolean> {
  try {
    await Promise.race([
      page.title(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("__HUNG__")), ms),
      ),
    ]);
    return false;
  } catch (error: any) {
    return String(error?.message ?? error) === "__HUNG__";
  }
}

async function startFixture(): Promise<void> {  const encoded = Buffer.from(FIXTURE, "utf8").toString("base64");
  await execSSHCommand(
    `echo '${encoded}' | base64 -d > /tmp/hung-nav-fixture.py`,
    20_000,
  );
  // The kill is its own SSH command, and its pattern is bracketed so it cannot
  // match this shell's own command line. Doing both in one line was a real
  // failure: `pkill -f '[h]ung-nav-fixture'` does not match itself, but the
  // `/tmp/hung-nav-fixture.py` later in the *same* line does — so pkill killed
  // the shell before it reached the launch, and the fixture never started.
  await execSSHCommand(`pkill -f 'hung-nav-fixtur[e]' ; echo CLEANED`, 15_000);
  // `setsid` and `</dev/null` are both load-bearing, the same way they are in
  // buildChromiumLaunchCommand: without them the process stays in the SSH
  // session's process group and is killed when the session closes — which
  // showed up as a fixture that logged nothing at all and never listened.
  await execSSHCommand(
    `setsid nohup python3 -u /tmp/hung-nav-fixture.py >/tmp/hung-nav-fixture.log 2>&1 </dev/null & sleep 1; echo STARTED`,
    20_000,
  );
  // Both ports have to be listening before the check means anything.
  for (let i = 0; i < 40; i += 1) {
    const up = await execSSHCommand(
      `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':${PAGE_PORT} ' && ` +
        `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':${HANG_PORT} ' && echo UP || echo DOWN`,
      10_000,
    );
    if (up.includes("UP")) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const log = await execSSHCommand("cat /tmp/hung-nav-fixture.log 2>&1", 10_000);
  throw new Error(
    `the fixture did not come up on :${PAGE_PORT}/:${HANG_PORT} — ${log.trim() || "(no log)"}`,
  );
}

async function main(): Promise<void> {
  loadConfig();

  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  console.log("\n=== Hung-navigation check (click delivered, navigation never commits) ===");

  if (!remoteBrowserEnabled()) {
    console.log("\nverdict: FAIL (BROWSER_AGENT_REMOTE is off)");
    process.exitCode = 1;
    return;
  }
  console.log(`  ssh        ${buildSSHConfig().username}@${buildSSHConfig().host}`);
  console.log(`  fixture    http://127.0.0.1:${PAGE_PORT}/ -> form posts to :${HANG_PORT}`);
  console.log("");

  const port = remoteCdpPort();
  let tunnel: { localPort: number; close(): void } | null = null;

  try {
    await startFixture();
    check("the fixture is up on the attack box", true);

    // No proxy: see the note at the top of this file.
    await launchRemoteChromium({ proxyUrl: "" });
    tunnel = await openBrowserTunnel(port);
    await waitForCdp(tunnel.localPort);
    const { browser, page } = await connectRemoteBrowser(tunnel.localPort);
    check("Playwright attached to the attack box's Chromium", !!browser && !!page);

    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    check("the fixture page loaded", page.url().includes(String(PAGE_PORT)), page.url());

    const submit = page.locator("button:has-text('Sign in')");

    // Positive control. Without this the rest of the check would pass on a
    // fixture that simply is not reproducing the hang.
    let rawMessage = "";
    try {
      await submit.click({ timeout: CLICK_TIMEOUT_MS });
    } catch (error: any) {
      rawMessage = String(error?.message ?? error);
    }
    check(
      "the raw click hangs exactly the way the report described",
      isPostActionNavigationTimeout(rawMessage),
      rawMessage.split("\n")[0] || "(the click did not hang)",
    );

    // The hint must stay quiet: the page was reached and the form was sent.
    check(
      "the proxy/VPN hint is NOT appended to a delivered click",
      browserReachabilityHint(rawMessage) === "",
      browserReachabilityHint(rawMessage) ? "hint was appended" : "no hint",
    );

    // The hang leaves the frame waiting for a navigation that never commits,
    // and every later read blocks behind it. Measured, and the reason the fix
    // has to cancel the load rather than only rename the error: without this the
    // page is unreadable for the rest of the run.
    check(
      "the page is unreadable while that navigation is pending",
      await readHangs(page),
    );
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    check("a fresh navigation clears it", !(await readHangs(page)));

    // The fix itself: the same click through runDomAction reports what happened,
    // and hands the page back in a state the next step can use.
    const line = await runDomAction(
      page,
      { action: "click", locator: { css: "button:has-text('Sign in')" }, timeout_ms: CLICK_TIMEOUT_MS },
      [],
    );
    check("the action is reported as delivered, not failed", /was delivered/.test(line), line.split("\n")[0]);
    check("the report does not say the action failed", !/failed/i.test(line));
    check("the report tells the model not to repeat it", /do not repeat the action/i.test(line));
    check(
      "the report states where the page actually is",
      /never committed|never finished loading/.test(line),
    );
    check(
      "the page is left readable after the delivered action",
      !(await readHangs(page)),
    );

    // The other half: an address that really is unreachable must still be
    // reported as such, with the hint. Otherwise "stop blaming the proxy" would
    // have been bought by silencing the hint entirely.
    //
    // 8123 rather than 1, deliberately: port 1 is on Chromium's own blocked list
    // and gives ERR_UNSAFE_PORT, which is a different failure and must NOT carry
    // the hint — see the unit test for that. This one has nothing listening.
    let unreachable = "";
    try {
      await runDomAction(
        page,
        { action: "navigate", url: "http://127.0.0.1:8123/", timeout_ms: 8_000 },
        [],
      );
    } catch (error: any) {
      unreachable = String(error?.message ?? error);
    }
    check(
      "an unreachable address still fails loudly",
      /ERR_CONNECTION_REFUSED/.test(unreachable),
      unreachable.split("\n")[0] || "(no error)",
    );
    check(
      "an unreachable address still carries the hint",
      browserReachabilityHint(unreachable) !== "",
    );
    check(
      "an unreachable address is not mistaken for a delivered action",
      !isPostActionNavigationTimeout(unreachable),
    );

    await browser.close();
    await killRemoteChromium(port);
  } catch (error: any) {
    check("the check completed", false, error?.message ?? String(error));
    await killRemoteChromium(port);
  } finally {
    tunnel?.close();
    await execSSHCommand(`pkill -f 'hung-nav-fixtur[e]' ; echo CLEANED`, 10_000).catch(
      () => {},
    );
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
