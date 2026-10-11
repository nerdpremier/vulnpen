/**
 * Which screen the Browser Agent panel should stream.
 *
 * The agent's Chromium runs on the attack box (see remote-browser.service.ts),
 * but the panel embedded the *backend's* VNC stack unconditionally. Those are
 * two different machines with two different displays:
 *
 *   backend     Xvfb :99  + x11vnc :5999 + websockify :6080   (entrypoint.sh)
 *   attack box  Xvnc :89  +             + websockify :9020   (kali entrypoint)
 *
 * The attack box's own :9020 can never be published: it is on internal Docker
 * networks only, so the host has no route to it. The backend therefore bridges
 * it on `BROWSER_AGENT_DESKTOP_PORT` (default 9021, also entrypoint.sh), and
 * that bridged port — not :9020 — is the address the operator's browser opens.
 * See operatorNovncUrl.
 *
 * So the panel streamed an empty display holding a placeholder Chromium parked
 * on about:blank, while the agent clicked and typed on :89 — the operator could
 * not see the work being done, and the panel's own error text ("the backend's
 * VNC stack is not serving on display :99") blamed a stack that was never the
 * one in use. The browser has to be watched where it actually runs, which is
 * the same place the Desktop tab already points at.
 *
 * This module owns that decision and nothing else. It reports the view the
 * panel should embed; it never starts, repairs or stops either stack.
 */
import {
  getBrowserAgentDisplay,
  getBrowserAgentNovncPort,
  getBrowserAgentRfbPort,
  getOperatorDesktopPort,
  getVncRfbPort,
  getWebsockifyPort,
} from "../config/constants";
import { isPortListening } from "../utils/tcpProbe";
import { isDockerInternalHost } from "../utils/vncSetup";
import { getVncConfig, type VncConfig } from "./vnc-provisioning.service";
import {
  remoteBrowserDisplay,
  remoteBrowserEnabled,
  remoteCdpPort,
} from "./remote-browser.service";
import { execSSHCommand } from "./ssh.service";

/**
 * The probe is a single SSH round trip. It is bounded well below the frontend's
 * 3s retry interval so a box that is down reports itself down instead of
 * queueing requests behind an open connection.
 */
const PROBE_TIMEOUT_MS = 8_000;

export interface BrowserView {
  /** The machine that draws the agent's browser. */
  workHost: "attack-box" | "backend";
  /**
   * Whether the panel will embed a stream at all — headed mode is on.
   *
   * Decided here rather than from MAGNITUDE_HEADLESS alone: on the attack box
   * Chromium is always headful (see buildBrowserAgentConfig), so a remote
   * deployment has a live view whatever that setting says. Reading it as
   * "headless" would send the operator to change a setting that is not why
   * they cannot see anything.
   */
  available: boolean;
  /** The display being streamed, as that machine names it. */
  display: string;
  /** Port of the noVNC front end for that display. */
  novncPort: number;
  /**
   * Base URL for the noVNC page, in the form the *operator's* browser needs
   * (the iframe is loaded there, not here). Empty when the address is best
   * derived from the backend's own origin — see BrowserAgentPanel.
   */
  novncUrl: string;
  /** VNC password for that display, empty when it takes none. */
  password: string;
  rfbUp: boolean;
  novncUp: boolean;
  /** Whether the agent's own browser window is on that display right now. */
  browserRunning: boolean;
  /** Both halves of the stream are serving, so the panel can embed it. */
  running: boolean;
  /** Why the view could not be read, when it could not. */
  note?: string;
}

/**
 * One command that reports everything the panel needs about the attack box:
 * whether the desktop's noVNC front end and the RFB server behind it are
 * listening, and whether the agent's Chromium is on that display.
 *
 * Two details are load-bearing. The `[r]` in the pgrep pattern keeps the
 * pattern from matching the shell that is running this very command — the
 * pattern text sits on that shell's command line, so a plain
 * `pgrep -f remote-debugging-port=9222` reports a browser that does not exist.
 * And `ss`/`netstat` are both tried because the Kali image ships one or the
 * other depending on its base.
 */
export function remoteDesktopProbeCommand(): string {
  const wsPort = getWebsockifyPort();
  const rfbPort = getVncRfbPort();
  const cdpPort = remoteCdpPort();
  return [
    'export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'probe() { (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$1 " && echo UP || echo DOWN; }',
    `printf 'WS=%s\\n' "$(probe ${wsPort})"`,
    `printf 'RFB=%s\\n' "$(probe ${rfbPort})"`,
    `pgrep -f '[r]emote-debugging-port=${cdpPort}' >/dev/null 2>&1 && echo CHROME=UP || echo CHROME=DOWN`,
  ].join("; ");
}

/**
 * Read the probe's output.
 *
 * A missing line reads as DOWN on purpose: the probe is run to find out whether
 * the stream is serviceable, so an answer that did not arrive must not be
 * mistaken for an answer of "yes".
 */
export function parseRemoteDesktopProbe(output: string): {
  novncUp: boolean;
  rfbUp: boolean;
  browserRunning: boolean;
} {
  const read = (key: string): boolean =>
    new RegExp(`^${key}=UP$`, "m").test(output || "");
  return {
    novncUp: read("WS"),
    rfbUp: read("RFB"),
    browserRunning: read("CHROME"),
  };
}

/**
 * The noVNC address for the operator's browser, mirroring the Desktop tab.
 *
 * Three sources, in the order that decides them:
 *
 *   1. `VNC_BASE_URL` — an operator-supplied override always wins.
 *   2. The backend's bridge port, when the deployment configures one.
 *   3. The VNC host itself, with a Docker-internal alias translated to
 *      localhost: `kali` resolves inside the Compose network but not from the
 *      browser that loads the iframe.
 *
 * (2) exists because (3) cannot work in the Docker deployment. The attack box
 * sits on `control` and `fenced`, both `internal: true`, so Docker has no route
 * from the host into it and simply never applies the port mapping — measured:
 * `NetworkSettings.Ports` comes back `{"9020/tcp":[]}` even though the compose
 * file declares it, and `docker port` prints nothing. The panel therefore
 * embedded `http://localhost:9020`, which is nothing on the host, and the iframe
 * stayed blank. The backend bridges it on a port that *is* published, which is
 * the only address the operator's browser can actually open.
 */
export function operatorNovncUrl(config: VncConfig): string {
  const base = (config.baseUrl || "").trim();
  if (base) return base.replace(/\/+$/, "");

  const bridged = bridgedOperatorUrl(config);
  if (bridged) return bridged;

  const host = isDockerInternalHost(config.host)
    ? "localhost"
    : config.host || "localhost";
  return `http://${host}:${config.port || getWebsockifyPort()}`;
}

/**
 * The backend's bridge address for this deployment, or null when it does not
 * apply.
 *
 * Only when the configured VNC host is *not* something the operator's browser
 * can open on its own. `localhost`, loopback and a Docker-internal alias all
 * qualify — they name this machine, and the box that is actually serving the
 * desktop is not reachable from the host at all. A routable address (an IP or a
 * dotted name) does not: that is a genuinely remote attack box, the operator can
 * reach it directly, and the bridge — whose target is this deployment's `kali`
 * — would point somewhere else entirely.
 */
function bridgedOperatorUrl(config: VncConfig): string | null {
  const port = getOperatorDesktopPort();
  if (port <= 0) return null;

  const host = (config.host || "").trim().toLowerCase();
  const operatorLocal =
    !host ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    isDockerInternalHost(host);
  if (!operatorLocal) return null;

  return `http://localhost:${port}`;
}

/**
 * The port that address uses, so the panel's fallback agrees with it.
 *
 * Kept beside `operatorNovncUrl` because the two must not drift: the panel
 * prefers `novncUrl` but falls back to building one from `novncPort` and the
 * backend's origin, and a fallback pointing at a different port than the URL
 * would be a second, quieter version of the same bug.
 */
export function operatorNovncPort(config: VncConfig): number {
  const bridged = bridgedOperatorUrl(config);
  if (bridged) return Number(bridged.split(":").pop());
  const port = Number(config.port);
  return Number.isInteger(port) && port > 0 ? port : getWebsockifyPort();
}

/** The backend's own stack: probeable in-process, since it is in this container. */
async function resolveBackendView(
  inDocker: boolean,
  available: boolean,
): Promise<BrowserView> {
  const [rfbUp, novncUp] = inDocker
    ? await Promise.all([
        isPortListening(getBrowserAgentRfbPort()),
        isPortListening(getBrowserAgentNovncPort()),
      ])
    : [false, false];

  return {
    workHost: "backend",
    available,
    display: getBrowserAgentDisplay(),
    novncPort: getBrowserAgentNovncPort(),
    // Left empty so the panel derives the host from the backend's own origin,
    // which is what a deployment reached over anything but localhost needs.
    novncUrl: "",
    password: "",
    rfbUp,
    novncUp,
    browserRunning: false,
    running: inDocker && rfbUp && novncUp,
  };
}

/**
 * The attack box's desktop.
 *
 * `probe` is false while nothing is going to be streamed yet (the agent is
 * disabled, or a local launch is headless): the panel returns before it embeds
 * anything in those states, so paying for an SSH round trip on every poll would
 * be pure cost.
 */
async function resolveAttackBoxView(options: {
  probe: boolean;
  available: boolean;
  run: () => Promise<string>;
}): Promise<BrowserView> {
  const config = getVncConfig();

  const view: BrowserView = {
    workHost: "attack-box",
    available: options.available,
    display: remoteBrowserDisplay(),
    novncPort: operatorNovncPort(config),
    novncUrl: operatorNovncUrl(config),
    password: config.password || "",
    rfbUp: false,
    novncUp: false,
    browserRunning: false,
    running: false,
  };

  if (!options.probe) return view;

  try {
    const measured = parseRemoteDesktopProbe(await options.run());
    return {
      ...view,
      rfbUp: measured.rfbUp,
      novncUp: measured.novncUp,
      browserRunning: measured.browserRunning,
      running: measured.rfbUp && measured.novncUp,
    };
  } catch (error: any) {
    // Reported, not hidden behind a fallback to the backend's stack: that
    // display exists and is serving, so embedding it would look like success
    // while showing a screen the agent is not on.
    return {
      ...view,
      note: `The attack box did not answer: ${error?.message || String(error)}`,
    };
  }
}

export async function resolveBrowserView(options: {
  inDocker: boolean;
  magnitudeEnabled: boolean;
  headless: boolean;
  /** Injected by tests; the real one is one SSH round trip to the attack box. */
  probe?: () => Promise<string>;
}): Promise<BrowserView> {
  const remote = remoteBrowserEnabled();
  const available = options.magnitudeEnabled && (remote || !options.headless);
  const run =
    options.probe ??
    (() => execSSHCommand(remoteDesktopProbeCommand(), PROBE_TIMEOUT_MS));

  if (!remote) {
    return resolveBackendView(options.inDocker, available);
  }
  return resolveAttackBoxView({ probe: available, available, run });
}
