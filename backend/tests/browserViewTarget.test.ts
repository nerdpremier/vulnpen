import { test } from "node:test";
import assert from "node:assert/strict";
import {
  operatorNovncPort,
  operatorNovncUrl,
  parseRemoteDesktopProbe,
  remoteDesktopProbeCommand,
  resolveBrowserView,
} from "../src/services/browser-view.service";
import { remoteBrowserDisplay } from "../src/services/remote-browser.service";
import { getVncConfig } from "../src/services/vnc-provisioning.service";
import {
  getBrowserAgentDisplay,
  getBrowserAgentNovncPort,
} from "../src/config/constants";

/**
 * The panel has to follow the browser, and the browser runs on the attack box
 * unless remote mode is off. These tests pin the resolution, not the transport:
 * the SSH probe is injected so they describe behaviour rather than whether a
 * box happens to be reachable from wherever the suite runs.
 */

async function withModeAsync<T>(
  remote: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.BROWSER_AGENT_REMOTE;
  process.env.BROWSER_AGENT_REMOTE = remote ? "true" : "false";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_REMOTE;
    else process.env.BROWSER_AGENT_REMOTE = previous;
  }
}

/** A probe that records how often it ran and answers with a canned reading. */
function probeReturning(output: string) {
  const calls: number[] = [];
  const probe = async (): Promise<string> => {
    calls.push(Date.now());
    return output;
  };
  return { probe, calls };
}

/* ── The probe command ───────────────────────────────────────────────── */

test("the probe asks for both halves of the stream and for the browser", () => {
  const command = remoteDesktopProbeCommand();
  assert.match(command, /WS=/);
  assert.match(command, /RFB=/);
  assert.match(command, /CHROME=/);
  // The RFB port is the backend's VNC_* setting: the desktop on the work host
  // is provisioned from those same values (see vnc-provisioning.service).
  assert.ok(command.includes(`probe ${process.env.WEBSOCKIFY_PORT || 9020}`));
  assert.ok(command.includes(`probe ${process.env.VNC_RFBPORT || 5989}`));
});

test("the pgrep pattern cannot match the shell that runs it", () => {
  // A bare pattern sits on this command's own command line, so pgrep would
  // report a Chromium that does not exist and the panel would claim the agent
  // is working while the desktop is empty.
  const command = remoteDesktopProbeCommand();
  assert.ok(command.includes("'[r]emote-debugging-port="));
  assert.ok(!command.includes("'remote-debugging-port="));
  assert.ok(!/\bpkill\b/.test(command));
});

/* ── Reading the probe ───────────────────────────────────────────────── */

test("a healthy desktop and a running browser read as up", () => {
  const measured = parseRemoteDesktopProbe("WS=UP\nRFB=UP\nCHROME=UP\n");
  assert.deepEqual(measured, {
    novncUp: true,
    rfbUp: true,
    browserRunning: true,
  });
});

test("an idle desktop is up with no browser on it", () => {
  const measured = parseRemoteDesktopProbe("WS=UP\nRFB=UP\nCHROME=DOWN\n");
  assert.equal(measured.novncUp, true);
  assert.equal(measured.rfbUp, true);
  assert.equal(measured.browserRunning, false);
});

test("DOWN lines are read as down, not as a match for UP", () => {
  const measured = parseRemoteDesktopProbe("WS=DOWN\nRFB=DOWN\nCHROME=DOWN\n");
  assert.deepEqual(measured, {
    novncUp: false,
    rfbUp: false,
    browserRunning: false,
  });
});

test("an answer that never arrived is not mistaken for a yes", () => {
  // A dropped SSH connection, a box without ss/netstat, an empty stdout: all
  // of them mean "cannot be shown", and defaulting to up would embed a stream
  // that is not there.
  for (const output of ["", "\n", "command not found\n", "WS=\nRFB=maybe\n"]) {
    assert.deepEqual(
      parseRemoteDesktopProbe(output),
      { novncUp: false, rfbUp: false, browserRunning: false },
      `output ${JSON.stringify(output)} must read as down`,
    );
  }
});

/* ── The address the operator's browser loads ────────────────────────── */

test("a Docker-internal alias becomes localhost for the operator's browser", () => {
  const url = operatorNovncUrl({
    mode: "auto",
    host: "kali",
    port: "9020",
    password: "x",
    setupDone: true,
    baseUrl: "",
    configured: true,
  });
  assert.equal(url, "http://localhost:9020");
});

test("a routable host is left alone", () => {
  assert.equal(
    operatorNovncUrl({
      mode: "manual",
      host: "10.0.0.9",
      port: "5901",
      password: "x",
      setupDone: false,
      baseUrl: "",
      configured: true,
    }),
    "http://10.0.0.9:5901",
  );
});

/**
 * The attack box cannot publish its own noVNC port.
 *
 * It is attached to `control` and `fenced` only, both `internal: true`, and
 * Docker does not apply a port mapping for a container the host has no route
 * into — measured on the real deployment: the compose file declares
 * `127.0.0.1:9020:9020`, `HostConfig.PortBindings` carries it, and
 * `NetworkSettings.Ports` still comes back `{"9020/tcp":[]}` with `docker port`
 * printing nothing. So the panel embedded `http://localhost:9020`, where nothing
 * listens on the host, and the iframe stayed blank.
 *
 * The backend bridges it instead (entrypoint.sh), and these tests pin the rule
 * that the operator is sent to the bridge rather than to the box.
 */
function withDesktopBridge<T>(port: string, fn: () => T): T {
  const previous = process.env.BROWSER_AGENT_DESKTOP_PORT;
  process.env.BROWSER_AGENT_DESKTOP_PORT = port;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_DESKTOP_PORT;
    else process.env.BROWSER_AGENT_DESKTOP_PORT = previous;
  }
}

const bridgedConfig = (host: string) => ({
  mode: "auto",
  host,
  port: "9020",
  password: "x",
  setupDone: true,
  baseUrl: "",
  configured: true,
});

test("the bridged port is used instead of the attack box's own", () => {
  withDesktopBridge("9021", () => {
    // Every way this deployment names the box: the host-facing .env value, and
    // the Compose alias the backend would otherwise reach it by.
    for (const host of ["localhost", "127.0.0.1", "kali", ""]) {
      assert.equal(
        operatorNovncUrl(bridgedConfig(host)),
        "http://localhost:9021",
        host,
      );
    }
    // The panel's fallback port has to agree, or it rebuilds the same broken URL.
    assert.equal(operatorNovncPort(bridgedConfig("localhost")), 9021);
  });
});

test("a genuinely remote attack box is not sent through the bridge", () => {
  withDesktopBridge("9021", () => {
    // The bridge's target is this deployment's `kali`. A box the operator can
    // reach directly must keep its own address, or the panel would stream the
    // wrong machine.
    assert.equal(
      operatorNovncUrl(bridgedConfig("10.0.0.9")),
      "http://10.0.0.9:9020",
    );
    assert.equal(
      operatorNovncUrl(bridgedConfig("vnc.example.test")),
      "http://vnc.example.test:9020",
    );
    assert.equal(operatorNovncPort(bridgedConfig("10.0.0.9")), 9020);
  });
});

test("a base URL still beats the bridge", () => {
  withDesktopBridge("9021", () => {
    assert.equal(
      operatorNovncUrl({ ...bridgedConfig("localhost"), baseUrl: "https://vnc.example.test/novnc/" }),
      "https://vnc.example.test/novnc",
    );
  });
});

test("without a bridge the attack box's own port is still used", () => {
  // The dev deployment reaches the box directly, and there is no bridge there.
  withDesktopBridge("", () => {
    assert.equal(operatorNovncUrl(bridgedConfig("localhost")), "http://localhost:9020");
    assert.equal(operatorNovncPort(bridgedConfig("localhost")), 9020);
  });
});

test("a configured base URL wins and loses its trailing slash", () => {
  assert.equal(
    operatorNovncUrl({
      mode: "manual",
      host: "kali",
      port: "9020",
      password: "x",
      setupDone: true,
      baseUrl: "https://vnc.example.test/novnc/",
      configured: true,
    }),
    "https://vnc.example.test/novnc",
  );
});

test("a missing host or port still yields a usable address", () => {
  assert.equal(
    operatorNovncUrl({
      mode: "",
      host: "",
      port: "",
      password: "",
      setupDone: false,
      baseUrl: "",
      configured: false,
    }),
    "http://localhost:9020",
  );
});

/* ── The resolved view ───────────────────────────────────────────────── */

test("remote mode points the panel at the attack box's own desktop", async () => {
  await withModeAsync(true, async () => {
    const { probe } = probeReturning("WS=UP\nRFB=UP\nCHROME=UP\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: false,
      probe,
    });

    assert.equal(view.workHost, "attack-box");
    // The display the *browser* draws on, not the backend's own Xvfb — that
    // mismatch is what made the panel show an empty screen while the agent
    // worked on the other machine.
    assert.equal(view.display, remoteBrowserDisplay());
    assert.equal(view.novncPort, Number(getVncConfig().port));
    assert.ok(!view.novncUrl.includes(":6080"), `url was ${view.novncUrl}`);
    assert.equal(view.running, true);
    assert.equal(view.browserRunning, true);
  });
});

test("the desktop's password travels with the view", async () => {
  // The work host's Xvnc is started with -rfbauth, so a frame without this
  // stops at "Authentication required". Taken from the same config the Desktop
  // tab reads, so the two views cannot be sent different passwords.
  await withModeAsync(true, async () => {
    const { probe } = probeReturning("WS=UP\nRFB=UP\nCHROME=DOWN\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: false,
      probe,
    });
    assert.equal(view.password, getVncConfig().password);
  });
});

test("a desktop that is up with no browser on it is still streamable", async () => {
  await withModeAsync(true, async () => {
    const { probe } = probeReturning("WS=UP\nRFB=UP\nCHROME=DOWN\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: false,
      probe,
    });
    assert.equal(view.running, true);
    assert.equal(view.browserRunning, false);
  });
});

test("noVNC up with no RFB behind it is reported as not running", async () => {
  await withModeAsync(true, async () => {
    const { probe } = probeReturning("WS=UP\nRFB=DOWN\nCHROME=DOWN\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: false,
      probe,
    });
    assert.equal(view.novncUp, true);
    assert.equal(view.rfbUp, false);
    assert.equal(view.running, false);
  });
});

test("an unreachable attack box is reported, not silently swapped for the backend", async () => {
  // Falling back would look like success: the backend's placeholder display
  // exists and serves, so the panel would show an empty screen and call it the
  // agent's view.
  await withModeAsync(true, async () => {
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: false,
      probe: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });

    assert.equal(view.workHost, "attack-box");
    assert.equal(view.running, false);
    assert.ok(view.note?.includes("ETIMEDOUT"), `note was ${view.note}`);
  });
});

test("nothing is streamed before headed mode is on, so nothing is probed", async () => {
  // The endpoint is polled; an SSH round trip per poll to answer a question the
  // panel will not use is pure cost.
  await withModeAsync(true, async () => {
    const { probe, calls } = probeReturning("WS=UP\nRFB=UP\nCHROME=UP\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: false,
      headless: false,
      probe,
    });
    assert.equal(view.available, false);
    assert.equal(view.running, false);
    assert.equal(view.note, undefined);
    assert.equal(calls.length, 0);
  });
});

test("a local headless launch has no live view, and is not probed for one", async () => {
  await withModeAsync(false, async () => {
    const { probe, calls } = probeReturning("WS=UP\nRFB=UP\nCHROME=UP\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: true,
      probe,
    });
    assert.equal(view.available, false);
    assert.equal(calls.length, 0);
  });
});

test("on the attack box headed mode is not optional", async () => {
  // buildBrowserAgentConfig forces headless=false for a remote launch, so
  // reporting "headless mode is on" would send the operator to change a setting
  // that is not the reason they cannot see the browser.
  await withModeAsync(true, async () => {
    const { probe } = probeReturning("WS=UP\nRFB=UP\nCHROME=UP\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: true,
      probe,
    });
    assert.equal(view.available, true);
  });
});

test("with remote mode off the view stays the backend's own stack", async () => {
  await withModeAsync(false, async () => {
    const { probe, calls } = probeReturning("WS=UP\nRFB=UP\nCHROME=UP\n");
    const view = await resolveBrowserView({
      inDocker: true,
      magnitudeEnabled: true,
      headless: false,
      probe,
    });

    assert.equal(view.workHost, "backend");
    // The backend's own stack, which is what this deployment actually runs.
    assert.equal(view.display, getBrowserAgentDisplay());
    assert.equal(view.novncPort, getBrowserAgentNovncPort());
    // Left empty on purpose: the panel then derives the host from the origin
    // the operator reached the app on.
    assert.equal(view.novncUrl, "");
    assert.equal(calls.length, 0);
  });
});

test("outside Docker there is no live view to show", async () => {
  await withModeAsync(false, async () => {
    const view = await resolveBrowserView({
      inDocker: false,
      magnitudeEnabled: true,
      headless: false,
      probe: async () => "WS=UP\nRFB=UP\nCHROME=UP\n",
    });
    assert.equal(view.running, false);
    assert.equal(view.rfbUp, false);
    assert.equal(view.novncUp, false);
  });
});
