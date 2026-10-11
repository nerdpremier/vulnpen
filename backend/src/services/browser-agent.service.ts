/**
 * Shared, long-lived browser agent.
 *
 * The browser itself runs on the attack box, not here — see
 * remote-browser.service.ts for why. What this module owns is its *lifecycle*:
 * one browser for the process, reused across calls.
 *
 * A fresh Chromium per call would pay the full cold start every time even when
 * the same engagement keeps hitting the same target, and `agent.stop()` closes
 * the browser with its last context. So callers obtain the browser through
 * ensureBrowserAgent(), which transparently reuses the live one while its
 * configuration fingerprint is unchanged and rebuilds it when the proxy, the
 * display, the screen size or the launch target changes. Runs are serialized
 * with runBrowserAgentExclusive() because one browser can only be driven by one
 * run at a time.
 *
 * Serializing on one chain means a run that never settles takes the browser down
 * with it: every later call queues behind a promise that cannot resolve, so the
 * browser looks permanently hung and the agent loops on timeouts. The chain is
 * therefore deadline-guarded — a run that misses its deadline is rejected, and
 * the browser it was driving is discarded so the next call starts clean.
 */
import { getBurpBrowserHome } from "./burp-ca.service";
import { isPortListening } from "../utils/tcpProbe";
import { execSSHCommand } from "./ssh.service";
import type { MagnitudeLlmConfig } from "../utils/magnitudeLlm";
import {
  connectRemoteBrowser,
  killRemoteChromium,
  launchRemoteChromium,
  openBrowserTunnel,
  proxyUrlForAttackBox,
  remoteBrowserDisplay,
  remoteBrowserEnabled,
  remoteCdpPort,
  waitForCdp,
  type BrowserTunnel,
} from "./remote-browser.service";

export interface BrowserAgentRuntimeConfig {
  llm: MagnitudeLlmConfig;
  headless: boolean;
  proxyUrl: string;
  display: string;
  screen: string;
}

/** The launch-relevant subset, shared by the local and remote launchers. */
export interface BrowserLaunchOptions {
  proxyUrl: string;
  display: string;
  screen: string;
  headless: boolean;
}

const DEFAULT_SCREEN = "1280x800x24";
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_RUN_TIMEOUT_MS = 90_000;

/** Milliseconds the browser may sit idle before it is released. 0 disables. */
function idleTimeoutMs(): number {
  const raw = Number(process.env.BROWSER_AGENT_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return raw;
}

/**
 * Milliseconds one run may hold the browser before it is treated as hung.
 *
 * Deliberately below the browser_action tool's own 120s cap: the run reports the
 * real reason (a navigation or a proxy that never answers) instead of the tool
 * reporting a bare timeout with no context. Set to 0 to wait forever, which
 * reinstates the wedge this guard exists to prevent.
 */
function runTimeoutMs(): number {
  const raw = Number(process.env.BROWSER_AGENT_RUN_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RUN_TIMEOUT_MS;
  return raw;
}

/** Raised when a run missed its deadline and its browser was discarded. */
export class BrowserAgentWedgedError extends Error {
  constructor(ms: number) {
    super(
      `The browser did not come back within ${Math.round(ms / 1000)}s, so it was discarded. ` +
        "The next browser_action call starts from a fresh browser.",
    );
    this.name = "BrowserAgentWedgedError";
  }
}

/** Extract the render size from a Xvfb-style "1280x800x24" geometry string. */
export function parseViewport(screen: string): {
  width: number;
  height: number;
} {
  const [, w, h] = (screen || DEFAULT_SCREEN).match(/^(\d+)x(\d+)/) || [];
  return {
    width: w ? Number(w) : 1280,
    height: h ? Number(h) : 800,
  };
}

/**
 * Build the agent config and the fingerprint that decides when a live agent can
 * be reused.
 *
 * The fingerprint covers everything baked into a running browser, so a settings
 * change forces a rebuild on the next run instead of silently keeping the old
 * configuration. What that means differs by where the browser runs: locally the
 * LLM client is part of the agent, so it is part of the fingerprint; on the
 * attack box the browser is a plain Chromium reached over CDP and the LLM plays
 * no part in it, so the fingerprint covers only what shapes that browser.
 */
export function buildBrowserAgentConfig(config: BrowserAgentRuntimeConfig): {
  fingerprint: string;
  agentConfig: any;
  launch: BrowserLaunchOptions;
} {
  const viewport = parseViewport(config.screen);
  const remote = remoteBrowserEnabled();

  // On the attack box Chromium is always headful: the operator watches and can
  // take over the same desktop through noVNC, which is the point of putting the
  // browser there. MAGNITUDE_HEADLESS therefore only applies to a local launch.
  const headless = remote ? false : config.headless;

  const launch: BrowserLaunchOptions = {
    proxyUrl: remote ? proxyUrlForAttackBox(config.proxyUrl) : config.proxyUrl,
    // A display name means different things on the two boxes: on the attack box
    // it is that box's own Xvnc desktop, not the backend's Xvfb. Reusing the
    // backend's value would point the remote Chromium at a display that does not
    // exist there, and it would exit at once.
    display: remote ? remoteBrowserDisplay() : config.display,
    screen: config.screen,
    headless,
  };

  const browserEnv = {
    ...process.env,
    HOME: getBurpBrowserHome(),
    ...(headless ? {} : { DISPLAY: config.display }),
  };
  const launchOptions: any = { headless, env: browserEnv };
  if (launch.proxyUrl) {
    launchOptions.proxy = { server: launch.proxyUrl };
  }
  if (!headless) {
    // No window manager runs on the Xvfb display, so --start-maximized is a
    // no-op; size the window to the screen explicitly.
    launchOptions.args = [`--window-size=${viewport.width},${viewport.height}`];
  }

  const fingerprint = remote
    ? JSON.stringify({
        target: "attack-box",
        cdpPort: remoteCdpPort(),
        proxyUrl: launch.proxyUrl,
        display: launch.display,
        viewport,
      })
    : JSON.stringify({
        target: "local",
        provider: config.llm.provider,
        model: config.llm.options.model,
        baseUrl: config.llm.options.baseUrl ?? "",
        apiKey: config.llm.options.apiKey,
        headless,
        proxyUrl: config.proxyUrl,
        display: config.display,
        viewport,
      });

  const agentConfig: any = {
    narrate: false,
    browser: {
      launchOptions,
      // Magnitude merges an explicit deviceScaleFactor into every context, and
      // Playwright rejects deviceScaleFactor combined with viewport: null - so
      // the viewport must always be a real size.
      contextOptions: { ignoreHTTPSErrors: true, viewport },
    },
    llm: {
      provider: config.llm.provider,
      options: config.llm.options,
    },
  };

  return { fingerprint, agentConfig, launch };
}

/**
 * Is the configured proxy actually reachable by the browser?
 *
 * Returns a human-readable problem, or null when the address is usable. The
 * browser runs on the attack box, so "reachable" has to be judged from there:
 * `http://kali:8080` is loopback to that box and unroutable from here, so
 * probing it from this process would report a working proxy as missing.
 *
 * A proxy nothing answers on turns every navigation into a hang; probing first
 * turns that into one actionable sentence before Chromium is launched at all.
 */
export async function probeBrowserProxy(
  proxyUrl: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  const raw = (proxyUrl || "").trim();
  if (!raw) return null;

  const target = remoteBrowserEnabled() ? proxyUrlForAttackBox(raw) : raw;

  let host: string;
  let port: number;
  try {
    const url = new URL(target.includes("://") ? target : `http://${target}`);
    host = url.hostname;
    port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return `The Browser Agent proxy "${raw}" is not a valid URL.`;
  }
  if (!host || !Number.isFinite(port) || port <= 0) {
    return `The Browser Agent proxy "${raw}" has no usable host and port.`;
  }
  // The host and port are interpolated into a shell command on the attack box,
  // so refuse anything that is not a plain hostname or address.
  if (!/^[A-Za-z0-9._:-]+$/.test(host) || !Number.isInteger(port)) {
    return `The Browser Agent proxy "${raw}" has a host the attack box cannot be asked about.`;
  }

  if (remoteBrowserEnabled()) {
    let reachable = false;
    try {
      const output = await execSSHCommand(
        `bash -c 'exec 3<>/dev/tcp/${host}/${port}' >/dev/null 2>&1 && echo UP || echo DOWN`,
        timeoutMs + 5_000,
      );
      reachable = output.includes("UP");
    } catch (error: any) {
      return (
        `The attack box could not be reached to check the Browser Agent proxy ${host}:${port} ` +
        `(${error?.message ?? error}). Check the SSH settings under Settings -> Connection.`
      );
    }
    if (reachable) return null;
    return (
      `Nothing is listening on the Browser Agent proxy ${host}:${port} on the attack box, so ` +
      "the browser cannot reach anything through it. Start the proxy there, or clear the proxy " +
      "setting and test that target with the attack box's own tools."
    );
  }

  if (await isPortListening(port, host, timeoutMs)) return null;
  return (
    `Nothing is listening on the Browser Agent proxy ${host}:${port}, so the browser cannot ` +
      "reach anything through it. The browser is running locally " +
      "(BROWSER_AGENT_REMOTE=false): start the proxy where the backend can reach it, or clear " +
      "the proxy setting and test that target with the attack box's own tools."
  );
}

let activeAgent: any = null;
let activeFingerprint: string | null = null;
let runChain: Promise<unknown> = Promise.resolve();
let idleTimer: NodeJS.Timeout | null = null;

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** Stop and forget the shared agent. Safe to call when nothing is running. */
export async function stopBrowserAgent(): Promise<void> {
  clearIdleTimer();
  const agent = activeAgent;
  activeAgent = null;
  activeFingerprint = null;
  if (agent) {
    try {
      await agent.stop();
    } catch (error: any) {
      console.warn(
        "Failed to stop shared Browser Agent:",
        error?.message ?? error,
      );
    }
  }
}

/**
 * Bring up Chromium on the attack box and attach to it over CDP.
 *
 * The tunnel and the browser are released together: the CDP connection runs
 * over the tunnel, so either one without the other is not a usable pair.
 */
async function startRemoteAgent(launch: BrowserLaunchOptions): Promise<any> {
  const port = remoteCdpPort();

  await launchRemoteChromium({
    proxyUrl: launch.proxyUrl,
    display: launch.display,
    screen: launch.screen,
  });

  let tunnel: BrowserTunnel;
  try {
    tunnel = await openBrowserTunnel(port);
  } catch (error) {
    // The browser came up but nothing can reach it; leaving it running would
    // hold the profile and the display for a connection that will never come.
    await killRemoteChromium(port);
    throw error;
  }

  try {
    await waitForCdp(tunnel.localPort);
    const { browser, page } = await connectRemoteBrowser(tunnel.localPort);

    return {
      page,
      /**
       * Open a URL. The counterpart of the Magnitude agent's own nav(), which
       * the "open this in the live view" panel calls; the DOM path drives
       * navigation through runDomAction instead.
       */
      async nav(url: string): Promise<void> {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      },
      async stop(): Promise<void> {
        // browser.close() alone does NOT terminate a browser attached with
        // connectOverCDP. Measured, not assumed: after this call returns, the
        // Chromium process is still on the attack box, still holding its
        // memory, its profile and its connection to the proxy. So an idle
        // release has to stop it over SSH too, or "released" would only mean
        // "disconnected from" — the browser would outlive every run that
        // started it, with nothing left able to reconnect.
        try {
          await browser.close();
        } catch {
          // Already gone; the kill below is the authority either way.
        }
        await killRemoteChromium(port);
        tunnel.close();
      },
    };
  } catch (error) {
    tunnel.close();
    await killRemoteChromium(port);
    throw error;
  }
}

/**
 * Launch Chromium beside the backend, as Magnitude does by default.
 *
 * Only reachable with BROWSER_AGENT_REMOTE=false, for a deployment that has no
 * attack box. It cannot see a target that only the attack box can reach.
 */
async function startLocalAgent(agentConfig: any): Promise<any> {
  const { startBrowserAgent } = await import("magnitude-core");
  return startBrowserAgent(agentConfig);
}

/**
 * Return the live shared agent, creating (or recreating) it when the
 * fingerprint changes. Always call inside runBrowserAgentExclusive().
 */
export async function ensureBrowserAgent(
  fingerprint: string,
  agentConfig: any,
  launch: BrowserLaunchOptions,
): Promise<any> {
  clearIdleTimer();
  if (activeAgent && activeFingerprint === fingerprint) {
    return activeAgent;
  }
  await stopBrowserAgent();
  const agent = remoteBrowserEnabled()
    ? await startRemoteAgent(launch)
    : await startLocalAgent(agentConfig);
  activeAgent = agent;
  activeFingerprint = fingerprint;
  return agent;
}

/**
 * Drop an agent whose run missed its deadline.
 *
 * The abandoned run still holds the page it was driving, so the stop is
 * best-effort: whatever it throws belongs to a browser nobody will ask for
 * again. State is cleared before the first await so the next run cannot pick the
 * corpse up.
 */
async function discardWedgedAgent(): Promise<void> {
  clearIdleTimer();
  const agent = activeAgent;
  activeAgent = null;
  activeFingerprint = null;
  if (!agent) return;
  try {
    await agent.stop();
  } catch (error: any) {
    console.warn(
      "Failed to stop the browser that missed its run deadline:",
      error?.message ?? error,
    );
  }
}

/**
 * Serialize access to the shared agent. A Magnitude agent drives a single goal
 * at a time, so concurrent browser_action calls queue instead of interleaving.
 *
 * The chain advances on the run's own deadline as well as on its result. Without
 * that, one run that never settles — a navigation through a proxy that never
 * answers, a launch that hangs — leaves every later call queued behind it, which
 * is what made the browser look permanently hung and the agent loop on timeouts.
 */
export function runBrowserAgentExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = runChain.then(fn, fn);
  const guarded = withRunDeadline(run);
  runChain = guarded.then(
    () => undefined,
    () => undefined,
  );
  return guarded;
}

function withRunDeadline<T>(run: Promise<T>): Promise<T> {
  const ms = runTimeoutMs();
  if (ms <= 0) return run;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Unref'd: a wedged run must not hold the server open at shutdown.
      void discardWedgedAgent();
      reject(new BrowserAgentWedgedError(ms));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    run.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Arm the idle timeout that releases the browser after a quiet period. */
export function scheduleBrowserAgentIdleStop(): void {
  clearIdleTimer();
  const ms = idleTimeoutMs();
  if (ms <= 0) return;
  idleTimer = setTimeout(() => {
    void runBrowserAgentExclusive(stopBrowserAgent);
  }, ms);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}
