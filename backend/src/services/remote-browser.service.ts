/**
 * The Browser Agent's Chromium lives on the attack box, not here.
 *
 * The browser used to be launched inside the backend container. That put it on
 * the wrong side of the network for the work it does: a target reachable only
 * through the attack box's VPN could never be opened from the backend, and the
 * proxy the browser used had to be configured by hand rather than inherited
 * from the box it should have been running on.
 *
 * Running it on the attack box fixes both at once: the browser inherits that
 * container's route to the target — the VPN OpenVPN brings up there — so it
 * does not have to be re-established for the browser by hand.
 *
 * This module owns the three things that makes possible:
 *
 *   1. launch   — start Chromium on the attack box over SSH, with the flags
 *                 the operator's settings imply (proxy, window size, display);
 *   2. tunnel   — an SSH port-forward from a loopback port here to Chromium's
 *                 CDP port there, so the debug endpoint is never exposed on any
 *                 network;
 *   3. attach   — Playwright's connectOverCDP against that local port.
 *
 * Chromium is launched by the backend rather than by the attack box's own
 * entrypoint on purpose: the launch flags then stay owned by the settings the
 * operator controls, so changing the proxy still takes effect, and the
 * fingerprint / idle-release / wedge-discard lifecycle in
 * browser-agent.service.ts keeps meaning what it did.
 */
import net from "net";
import { Client as SSHClient } from "ssh2";
import { buildSSHConfig, type SSHConfig } from "../utils/sshConfig";
import { execSSHCommand } from "./ssh.service";

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_PROFILE_DIR = "/kali-data/chromium-home";
/**
 * The attack box's own desktop display.
 *
 * Deliberately NOT MAGNITUDE_DISPLAY: that names a display on the *backend*
 * (its Xvfb is :99), and pointing the attack box's Chromium at it makes it exit
 * with "Missing X server or $DISPLAY". The attack box draws on the Xvnc desktop
 * its own entrypoint starts.
 */
const DEFAULT_DISPLAY = ":89";
const DEFAULT_SCREEN = "1280x800x24";
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Where Chromium keeps its profile on the attack box.
 *
 * Deliberately inside /kali-data: that directory is bind-mounted into BOTH the
 * attack box and the backend, so the profile's NSS certificate store is
 * readable and writable from here. That is what lets the backend install Burp's
 * CA into the remote browser's trust store directly, instead of shelling out
 * over SSH every time Burp rotates its CA.
 */
export function remoteBrowserHome(): string {
  return (process.env.BROWSER_AGENT_PROFILE_DIR || "").trim() || DEFAULT_PROFILE_DIR;
}

export function remoteCdpPort(): number {
  const raw = Number(process.env.BROWSER_AGENT_CDP_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CDP_PORT;
}

/**
 * The display the remote Chromium should draw on.
 *
 * Its own setting, not MAGNITUDE_DISPLAY: that one names a display on the
 * backend (its Xvfb runs on :99), and the attack box has no X server there — it
 * has the Xvnc desktop its entrypoint starts on :89. Reusing the backend's value
 * makes Chromium exit at once with "Missing X server or $DISPLAY".
 */
export function remoteBrowserDisplay(): string {
  const raw = (process.env.BROWSER_AGENT_DISPLAY || "").trim();
  if (!raw) return DEFAULT_DISPLAY;
  return raw.startsWith(":") ? raw : `:${raw}`;
}

/**
 * Is the browser meant to run on the attack box?
 *
 * Defaults to on — that is the intended architecture — and can be turned off
 * with BROWSER_AGENT_REMOTE=false, which restores launching Chromium locally
 * for a deployment that has no attack box at all.
 */
export function remoteBrowserEnabled(): boolean {
  const raw = (process.env.BROWSER_AGENT_REMOTE || "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "local") {
    return false;
  }
  return true;
}

/**
 * Rewrite a proxy URL into the form the attack box sees.
 *
 * The operator configures the proxy the way the *backend* reaches it, which for
 * the built-in attack box is `http://kali:8080` — a Docker-internal alias.
 * Chromium runs on that box, so the same listener is simply loopback there.
 * Any other host is left alone: an external proxy is addressed the same way
 * from both sides.
 */
export function proxyUrlForAttackBox(proxyUrl: string): string {
  const raw = (proxyUrl || "").trim();
  if (!raw) return "";

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return raw;
  }

  const attackBoxNames = new Set(
    [
      process.env.SSH_HOST,
      "kali",
      "vulnpen-kali",
      "localhost",
      "127.0.0.1",
      "host.docker.internal",
    ]
      .map((n) => (n || "").trim().toLowerCase())
      .filter(Boolean),
  );

  if (attackBoxNames.has(url.hostname.toLowerCase())) {
    url.hostname = "127.0.0.1";
  }

  // Rebuilt as `scheme://[user:pass@]host:port` rather than stringified, because
  // Chromium's `--proxy-server` takes exactly that and nothing else. `url.href`
  // always appends a trailing slash, and a slash makes Chromium resolve an empty
  // proxy list, so every request then fails with ERR_NO_SUPPORTED_PROXIES —
  // measured, same host and port both ways: with the slash it never loads,
  // without it it does. Any path is dropped for the same reason: a proxy URL has
  // no meaningful path, and `--proxy-server` cannot express one.
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
    : "";
  return `${url.protocol}//${auth}${url.host}`;
}

/** POSIX single-quote a value so it survives the shell on the attack box. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** A loopback port forwarding to a port on the attack box over one SSH connection. */
export interface BrowserTunnel {
  localPort: number;
  close(): void;
}

/**
 * Open an SSH port-forward from an ephemeral loopback port to `remotePort` on
 * the attack box.
 *
 * Binding the local end to 127.0.0.1 keeps the CDP endpoint off every network
 * interface: the only way to reach it is through this process. Chromium on the
 * far side binds loopback for the same reason, so the tunnel is the sole path
 * to it from either direction.
 */
export function openBrowserTunnel(
  remotePort: number,
  remoteHost = "127.0.0.1",
  timeoutMs = 10_000,
): Promise<BrowserTunnel> {
  const sshConfig: SSHConfig = buildSSHConfig();

  return new Promise<BrowserTunnel>((resolve, reject) => {
    const ssh = new SSHClient();
    const sockets = new Set<net.Socket>();
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      try {
        ssh.end();
      } catch {
        // The connection is already gone; nothing to release.
      }
      reject(error);
    };

    ssh.on("ready", () => {
      const server = net.createServer((local) => {
        sockets.add(local);
        local.on("close", () => sockets.delete(local));
        local.on("error", () => local.destroy());

        ssh.forwardOut(
          "127.0.0.1",
          local.localPort || 0,
          remoteHost,
          remotePort,
          (error: Error | undefined, stream: any) => {
            if (error) {
              local.destroy();
              return;
            }
            local.pipe(stream).pipe(local);
            // Either end closing must take the other with it, or a dropped CDP
            // socket would leave a half-open pair behind for every reconnect.
            stream.on("close", () => local.destroy());
            local.on("close", () => {
              try {
                stream.close();
              } catch {
                // Already closed.
              }
            });
          },
        );
      });

      server.on("error", fail);
      server.listen(0, "127.0.0.1", () => {
        if (settled) {
          server.close();
          return;
        }
        settled = true;
        const localPort = (server.address() as net.AddressInfo).port;
        resolve({
          localPort,
          close(): void {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            try {
              server.close();
            } catch {
              // Already closed.
            }
            try {
              ssh.end();
            } catch {
              // Already closed.
            }
          },
        });
      });
    });

    ssh.on("error", fail);
    ssh.on("close", () => {
      // A tunnel that drops after it was handed out is not reported here — the
      // CDP connection dies with it, and the caller rebuilds the browser on the
      // next run. Only a close before readiness is an error.
      if (!settled) fail(new Error("The SSH tunnel to the attack box closed before it was ready."));
    });

    ssh.connect({
      ...sshConfig,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      readyTimeout: timeoutMs,
    });
  });
}

/**
 * Build the shell command that starts Chromium on the attack box.
 *
 * Exported so the exact string can be asserted in a test: it is assembled from
 * operator-controlled values and run through a shell on another host, so it is
 * worth pinning that it stays a single well-formed command.
 *
 * Note what is deliberately NOT here: stopping the previous browser. That has to
 * run as its own command — this one carries `--remote-debugging-port=…` on its
 * own command line, so a `pkill -f` for that pattern in the same shell matches
 * the shell itself and kills it before it reaches the launch. See
 * launchRemoteChromium.
 */
export function buildChromiumLaunchCommand(options: {
  port: number;
  home: string;
  display: string;
  screen: string;
  proxyUrl?: string;
}): string {
  const { width, height } = parseScreen(options.screen);
  const profile = `${options.home}/profile`;
  const flags = [
    `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1",
    // Chromium 111+ rejects a CDP WebSocket whose Origin it does not allow;
    // without this the handshake fails with an opaque 403.
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    // The attack box runs as root, which Chromium refuses to start under
    // without this.
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    `--window-size=${width},${height}`,
  ];
  if (options.proxyUrl) flags.push(`--proxy-server=${options.proxyUrl}`);

  // Joined with `;`. The launch and the readiness echo are a single element on
  // purpose: joining them with `; ` would put a `;` straight after the `&` that
  // backgrounds the browser, which the shell rejects outright.
  return [
    `mkdir -p ${shellQuote(options.home)}`,
    `CHROME="$(for b in chromium chromium-browser google-chrome; do command -v "$b" 2>/dev/null && break; done)"`,
    `if [ -z "$CHROME" ]; then echo "NO_CHROMIUM"; exit 3; fi`,
    // Clear a profile lock left behind by a browser that died with its
    // container.
    //
    // The profile lives on a shared bind mount (/kali-data), so it outlives the
    // container that wrote it. Chromium's SingletonLock records the *hostname*
    // of the machine holding it, so once the attack box is recreated — a new
    // image, `docker compose up -d --no-deps kali`, a crash — the lock names a
    // host that no longer exists and Chromium refuses to start at all:
    //
    //   The profile appears to be in use by another Chromium process (23323)
    //   on another computer (846f31541adc).
    //
    // It does not recover on its own, so without this every attack-box
    // replacement leaves the Browser Agent permanently unable to start — and
    // the error names a container that is already gone, which makes it look
    // like something else entirely.
    //
    // Safe to do unconditionally: launchRemoteChromium stops any Chromium on
    // this box first, so a lock that survives to this point is stale by
    // definition. Only the three lock files go — the profile itself holds
    // Burp's CA in its NSS store and has to be kept.
    `rm -f ${shellQuote(`${profile}/SingletonLock`)} ${shellQuote(`${profile}/SingletonCookie`)} ${shellQuote(`${profile}/SingletonSocket`)}`,
    `export DISPLAY=${shellQuote(options.display)}`,
    `export HOME=${shellQuote(options.home)}`,
    `setsid nohup "$CHROME" ${flags.map(shellQuote).join(" ")} about:blank ` +
      `>/tmp/chromium.log 2>&1 </dev/null & sleep 1; echo LAUNCHED`,
  ].join("; ");
}

/**
 * Start Chromium on the attack box with CDP enabled on its loopback.
 *
 * Any Chromium already listening on the port is stopped first: a browser left
 * over from a previous launch would still hold the old flags (the old proxy
 * above all), so reusing it would silently ignore the settings this call was
 * made to apply.
 */
export async function launchRemoteChromium(options: {
  proxyUrl?: string;
  display?: string;
  screen?: string;
  home?: string;
  port?: number;
}): Promise<void> {
  const port = options.port ?? remoteCdpPort();

  // Its own SSH command, and it must stay that way: see the note on
  // buildChromiumLaunchCommand.
  await killRemoteChromium(port);
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const script = buildChromiumLaunchCommand({
    port,
    home: options.home ?? remoteBrowserHome(),
    display: options.display || remoteBrowserDisplay(),
    screen: options.screen || DEFAULT_SCREEN,
    proxyUrl: (options.proxyUrl || "").trim(),
  });

  const output = await execSSHCommand(script, 30_000);
  if (output.includes("NO_CHROMIUM")) {
    throw new Error(
      "The attack box has no Chromium installed, so the Browser Agent has no engine. " +
        "Rebuild the attack box image (kali/Dockerfile installs chromium).",
    );
  }
  if (!output.includes("LAUNCHED")) {
    throw new Error(
      `Could not start Chromium on the attack box: ${output.trim() || "(no output)"}`,
    );
  }
}

/**
 * Stop the remote Chromium, if one is running, and wait until it is really gone.
 * Never throws.
 *
 * `pkill` only *signals*. Chromium handles SIGTERM by shutting down gracefully —
 * measured: the process was still on the box when a `pgrep` ran immediately
 * after this function returned (check:browser:remote caught it as "pid N
 * survived"), and it was gone a moment later. Returning before the process has
 * exited is not just a flaky assertion: `launchRemoteChromium` calls this and
 * launches 1s later, so a slow shutdown means the new browser can start while
 * the old one still holds the profile's SingletonLock — the failure mode that
 * makes Chromium refuse to start with "profile appears to be in use".
 *
 * So: SIGTERM, poll for actual exit, then SIGKILL anything still standing.
 */
export async function killRemoteChromium(port = remoteCdpPort()): Promise<void> {
  // The bracket keeps the pattern from matching the shell running it — this has
  // to stay a separate SSH command for the same reason.
  const pattern = shellQuote(`[r]emote-debugging-port=${port}`);
  try {
    await execSSHCommand(`pkill -f ${pattern} 2>/dev/null || true`, 10_000);

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const still = await execSSHCommand(`pgrep -f ${pattern} | head -1`, 10_000);
      if (!still.trim()) return;
      // Give graceful shutdown ~2s, then stop asking.
      if (attempt === 8) {
        await execSSHCommand(`pkill -9 -f ${pattern} 2>/dev/null || true`, 10_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch {
    // A browser that is already gone, or an attack box that is unreachable,
    // both mean the same thing here: there is nothing to stop.
  }
}

/**
 * Wait until the CDP endpoint behind the tunnel answers.
 *
 * Polling the version endpoint rather than sleeping a fixed interval: Chromium
 * is ready the moment it answers, and a browser that fails to start is reported
 * as a timeout with the browser's own log attached instead of as a mystery
 * connection error later.
 */
export async function waitForCdp(
  localPort: number,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error: any) {
      lastError = error?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Chromium on the attack box did not open its debug port within ` +
      `${Math.round(timeoutMs / 1000)}s (${lastError}). ` +
      "Check that the attack box is reachable and that its X server is running.",
  );
}

/** Attach Playwright to the Chromium behind the tunnel and return its page. */
export async function connectRemoteBrowser(localPort: number): Promise<{
  browser: any;
  page: any;
}> {
  const { chromium } = await import("patchright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${localPort}`);

  // connectOverCDP hands back the browser's existing default context. The
  // remote Chromium was launched with about:blank, so there is always at least
  // one page to drive.
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page };
}

function parseScreen(screen: string): { width: number; height: number } {
  const [, w, h] = (screen || DEFAULT_SCREEN).match(/^(\d+)x(\d+)/) || [];
  return {
    width: w ? Number(w) : 1280,
    height: h ? Number(h) : 800,
  };
}
