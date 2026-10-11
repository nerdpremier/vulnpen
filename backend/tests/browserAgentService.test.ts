import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildBrowserAgentConfig,
  parseViewport,
  probeBrowserProxy,
  runBrowserAgentExclusive,
} from "../src/services/browser-agent.service";
import {
  buildChromiumLaunchCommand,
  proxyUrlForAttackBox,
  remoteBrowserDisplay,
  remoteBrowserEnabled,
  remoteBrowserHome,
  remoteCdpPort,
  shellQuote,
} from "../src/services/remote-browser.service";
import {
  roleForLocator,
  runDomAction,
  unsupportedElementAction,
  type DomElement,
} from "../src/services/dom-browser.service";
import type { BrowserAgentRuntimeConfig } from "../src/services/browser-agent.service";

const baseConfig: BrowserAgentRuntimeConfig = {
  llm: {
    provider: "openai-generic",
    options: {
      model: "gpt-x",
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
    },
  },
  headless: true,
  proxyUrl: "",
  display: ":99",
  screen: "1280x800x24",
};

/**
 * The browser runs on the attack box by default, and that default changes what
 * a fingerprint covers and where a proxy probe is made. Tests that describe one
 * side of that split have to say which side they mean.
 */
function withMode<T>(remote: boolean, fn: () => T): T {
  const previous = process.env.BROWSER_AGENT_REMOTE;
  process.env.BROWSER_AGENT_REMOTE = remote ? "true" : "false";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_REMOTE;
    else process.env.BROWSER_AGENT_REMOTE = previous;
  }
}

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

test("parseViewport reads Xvfb geometry and falls back to defaults", () => {
  assert.deepEqual(parseViewport("1280x800x24"), { width: 1280, height: 800 });
  assert.deepEqual(parseViewport("1024x768x24"), { width: 1024, height: 768 });
  assert.deepEqual(parseViewport(""), { width: 1280, height: 800 });
  assert.deepEqual(parseViewport("garbage"), { width: 1280, height: 800 });
});

test("buildBrowserAgentConfig carries viewport and llm into the agent config", () => {
  const { agentConfig } = buildBrowserAgentConfig(baseConfig);
  assert.equal(agentConfig.browser.contextOptions.viewport.width, 1280);
  assert.equal(agentConfig.browser.contextOptions.viewport.height, 800);
  assert.equal(agentConfig.browser.contextOptions.ignoreHTTPSErrors, true);
  assert.equal(agentConfig.llm.provider, "openai-generic");
  assert.equal(agentConfig.llm.options.model, "gpt-x");
  assert.equal(agentConfig.narrate, false);
});

test("a local launch honours headless: no window size, no DISPLAY", () => {
  withMode(false, () => {
    const { agentConfig } = buildBrowserAgentConfig(baseConfig);
    assert.equal(agentConfig.browser.launchOptions.headless, true);
    assert.equal(agentConfig.browser.launchOptions.args, undefined);
    assert.equal(typeof agentConfig.browser.launchOptions.env.HOME, "string");
  });
});

test("a local headed launch sizes the window and sets DISPLAY", () => {
  withMode(false, () => {
    const { agentConfig } = buildBrowserAgentConfig({
      ...baseConfig,
      headless: false,
    });
    assert.equal(agentConfig.browser.launchOptions.headless, false);
    assert.deepEqual(agentConfig.browser.launchOptions.args, [
      "--window-size=1280,800",
    ]);
    assert.equal(agentConfig.browser.launchOptions.env.DISPLAY, ":99");
  });
});

test("a local launch wires the proxy into launch options as configured", () => {
  withMode(false, () => {
    const { agentConfig } = buildBrowserAgentConfig({
      ...baseConfig,
      proxyUrl: "http://burp:8080",
    });
    assert.deepEqual(agentConfig.browser.launchOptions.proxy, {
      server: "http://burp:8080",
    });
  });
});

test("the attack-box launch is always headful, whatever headless says", () => {
  withMode(true, () => {
    // The operator watches and can take over the same desktop over noVNC, which
    // is the reason the browser was moved there; a headless one would be
    // invisible on it.
    const { launch } = buildBrowserAgentConfig({ ...baseConfig, headless: true });
    assert.equal(launch.headless, false);
  });
});

test("the attack-box launch addresses Burp by loopback", () => {
  withMode(true, () => {
    // `http://kali:8080` is how the BACKEND reaches Burp. Chromium runs on kali,
    // where the same listener is simply 127.0.0.1:8080. The name does resolve
    // there (Docker aliases the container), but only back to this same box, so
    // it lands on the right listener by accident of naming rather than by
    // meaning. 127.0.0.1 says what is meant.
    //
    // Note the shape as well as the host: no trailing slash. See the test below
    // for why that matters.
    const { launch } = buildBrowserAgentConfig({
      ...baseConfig,
      proxyUrl: "http://kali:8080",
    });
    assert.equal(launch.proxyUrl, "http://127.0.0.1:8080");
  });
});

test("a local fingerprint covers what the agent bakes in", () => {
  withMode(false, () => {
    const base = buildBrowserAgentConfig(baseConfig).fingerprint;
    assert.equal(buildBrowserAgentConfig({ ...baseConfig }).fingerprint, base);

    const model = buildBrowserAgentConfig({
      ...baseConfig,
      llm: {
        provider: baseConfig.llm.provider,
        options: { ...baseConfig.llm.options, model: "gpt-y" },
      },
    }).fingerprint;
    assert.notEqual(base, model);

    const headless = buildBrowserAgentConfig({
      ...baseConfig,
      headless: false,
    }).fingerprint;
    assert.notEqual(base, headless);

    const screen = buildBrowserAgentConfig({
      ...baseConfig,
      screen: "1024x768x24",
    }).fingerprint;
    assert.notEqual(base, screen);
  });
});

test("an attack-box fingerprint covers the browser, not the agent's LLM", () => {
  withMode(true, () => {
    const base = buildBrowserAgentConfig(baseConfig).fingerprint;
    assert.equal(buildBrowserAgentConfig({ ...baseConfig }).fingerprint, base);

    // The remote Chromium is reached over CDP and never sees the LLM, so
    // changing the model must NOT tear the browser down and rebuild it.
    const model = buildBrowserAgentConfig({
      ...baseConfig,
      llm: {
        provider: baseConfig.llm.provider,
        options: { ...baseConfig.llm.options, model: "gpt-y" },
      },
    }).fingerprint;
    assert.equal(base, model);

    // These do shape the remote browser, so they must.
    assert.notEqual(
      base,
      buildBrowserAgentConfig({ ...baseConfig, screen: "1024x768x24" })
        .fingerprint,
    );
    assert.notEqual(
      base,
      buildBrowserAgentConfig({ ...baseConfig, proxyUrl: "http://kali:8080" })
        .fingerprint,
    );
  });
});

test("remoteBrowserEnabled defaults to on and can be turned off", () => {
  const previous = process.env.BROWSER_AGENT_REMOTE;
  try {
    delete process.env.BROWSER_AGENT_REMOTE;
    assert.equal(remoteBrowserEnabled(), true);
    for (const off of ["false", "0", "off", "local", "FALSE", " Off "]) {
      process.env.BROWSER_AGENT_REMOTE = off;
      assert.equal(remoteBrowserEnabled(), false, `"${off}" should mean local`);
    }
    process.env.BROWSER_AGENT_REMOTE = "true";
    assert.equal(remoteBrowserEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_REMOTE;
    else process.env.BROWSER_AGENT_REMOTE = previous;
  }
});

test("proxyUrlForAttackBox rewrites only the attack box's own names", () => {
  // Names that mean "the attack box" from the backend become loopback.
  for (const name of ["kali", "vulnpen-kali", "localhost", "127.0.0.1"]) {
    assert.equal(
      proxyUrlForAttackBox(`http://${name}:8080`),
      "http://127.0.0.1:8080",
      name,
    );
  }
  // An external proxy is addressed the same way from both sides.
  assert.equal(
    proxyUrlForAttackBox("http://proxy.example:3128"),
    "http://proxy.example:3128",
  );
  assert.equal(proxyUrlForAttackBox(""), "");
});

/**
 * The value handed to Chromium's `--proxy-server` must carry no trailing slash.
 *
 * This test used to assert the opposite — it expected `http://127.0.0.1:8080/`,
 * which is what `URL.href` produces — and so it locked the bug in place. A slash
 * makes Chromium resolve an empty proxy list, and then every request fails with
 * `net::ERR_NO_SUPPORTED_PROXIES`: measured on the real attack box, same host and
 * same port, with the slash it never loads a page and without it it does. Because
 * production passes this value straight into the launch flags, a configured proxy
 * was unusable and the agent could not reach anything through Burp.
 */
test("the proxy value never carries a trailing slash or a path", () => {
  const cases = [
    "http://kali:8080",
    "http://kali:8080/",
    "http://kali:8080/some/path",
    "kali:8080",
    "http://proxy.example:3128/",
  ];
  for (const input of cases) {
    const out = proxyUrlForAttackBox(input);
    assert.ok(!out.endsWith("/"), `${input} -> ${out} ends with a slash`);
    assert.ok(
      !/^[a-z0-9+.-]+:\/\/[^/]+\/.+/.test(out),
      `${input} -> ${out} still carries a path`,
    );
    assert.match(out, /^[a-z0-9+.-]+:\/\/[^/]+$/i, `${input} -> ${out}`);
  }

  // A non-default scheme and credentials survive; only the shape is normalised.
  assert.equal(proxyUrlForAttackBox("socks5://kali:1080"), "socks5://127.0.0.1:1080");
  assert.equal(
    proxyUrlForAttackBox("http://user:pass@kali:8080"),
    "http://user:pass@127.0.0.1:8080",
  );
  // IPv6 keeps its brackets, which `hostname` alone would drop.
  assert.equal(proxyUrlForAttackBox("http://[::1]:8080"), "http://[::1]:8080");
});

test("shellQuote survives a single quote in the value", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);

  // Round-trip through the quoting rule itself rather than through a shell:
  // spawning one is not portable across the platforms this suite runs on, and
  // the property being checked is the escaping, not the shell's behaviour.
  const unquote = (quoted: string): string => {
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), quoted);
    const segments = quoted.slice(1, -1).split(`'\\''`);
    for (const segment of segments) {
      assert.ok(!segment.includes("'"), `unescaped quote in ${quoted}`);
    }
    return segments.join("'");
  };

  for (const value of ["a'b\"c$HOME`id`", "''", "'a'", "no quotes at all"]) {
    assert.equal(unquote(shellQuote(value)), value, value);
  }
});

test("remote browser paths and port fall back to the attack box defaults", () => {
  const previous = {
    home: process.env.BROWSER_AGENT_PROFILE_DIR,
    port: process.env.BROWSER_AGENT_CDP_PORT,
  };
  try {
    delete process.env.BROWSER_AGENT_PROFILE_DIR;
    delete process.env.BROWSER_AGENT_CDP_PORT;
    // /kali-data is bind-mounted into both containers, which is what lets the
    // backend install Burp's CA into the remote profile without an SSH hop.
    assert.equal(remoteBrowserHome(), "/kali-data/chromium-home");
    assert.equal(remoteCdpPort(), 9222);

    process.env.BROWSER_AGENT_PROFILE_DIR = "/tmp/profile";
    process.env.BROWSER_AGENT_CDP_PORT = "9333";
    assert.equal(remoteBrowserHome(), "/tmp/profile");
    assert.equal(remoteCdpPort(), 9333);

    process.env.BROWSER_AGENT_CDP_PORT = "not-a-number";
    assert.equal(remoteCdpPort(), 9222);
  } finally {
    if (previous.home === undefined) delete process.env.BROWSER_AGENT_PROFILE_DIR;
    else process.env.BROWSER_AGENT_PROFILE_DIR = previous.home;
    if (previous.port === undefined) delete process.env.BROWSER_AGENT_CDP_PORT;
    else process.env.BROWSER_AGENT_CDP_PORT = previous.port;
  }
});

test("a run that never settles releases the chain instead of wedging it", async () => {
  // The regression this guards: the shared agent serialises runs on one chain, so
  // a run that never came back left every later browser_action queued behind a
  // promise that could not resolve — the browser looked permanently hung.
  process.env.BROWSER_AGENT_RUN_TIMEOUT_MS = "40";
  // The deadline timer is unref'd (a wedged run must not hold the server open),
  // so the test holds the loop open long enough for it to fire.
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const hung = runBrowserAgentExclusive(() => new Promise(() => {}));
    await assert.rejects(hung, /did not come back within/);

    // The point of the guard: the next run still gets through.
    assert.equal(await runBrowserAgentExclusive(async () => "alive"), "alive");
  } finally {
    clearTimeout(keepAlive);
    delete process.env.BROWSER_AGENT_RUN_TIMEOUT_MS;
  }
});

test("a normal run resolves and leaves the chain usable", async () => {
  assert.equal(await runBrowserAgentExclusive(async () => 1), 1);
  assert.equal(await runBrowserAgentExclusive(async () => 2), 2);
});

test("probeBrowserProxy passes an unset proxy and rejects an unusable one", async () => {
  assert.equal(await probeBrowserProxy(""), null);
  assert.match((await probeBrowserProxy("http://")) ?? "", /not a valid URL/);
});

test("a local probe reports a proxy nothing answers on", async () => {
  await withModeAsync(false, async () => {
    // Port 1 is reserved and nothing listens on it.
    const problem = await probeBrowserProxy("http://127.0.0.1:1", 300);
    assert.match(
      problem ?? "",
      /Nothing is listening on the Browser Agent proxy 127\.0\.0\.1:1/,
    );
  });
});

test("a remote probe refuses a host it cannot ask the attack box about", async () => {
  await withModeAsync(true, async () => {
    // The host is interpolated into a shell command on the attack box, so a
    // value that is not a plain hostname or address must be refused rather than
    // quoted into something the box would execute.
    const problem = await probeBrowserProxy("http://bad host;rm -rf /:8080", 300);
    assert.match(problem ?? "", /not a valid URL|has no usable host|the attack box cannot be asked/);
  });
});

test("the attack-box launch command is one well-formed shell command", () => {
  const command = buildChromiumLaunchCommand({
    port: 9222,
    home: "/kali-data/chromium-home",
    display: ":89",
    screen: "1280x800x24",
    proxyUrl: "http://127.0.0.1:8080",
  });

  // The regression this guards: the command is assembled by joining pieces with
  // `; `, so a piece ending in `&` produces `&;` — a syntax error the shell
  // rejects before anything runs, which would look like "the browser never
  // started" with no useful reason.
  assert.ok(!/&\s*;/.test(command), `& followed by ; in: ${command}`);
  assert.ok(command.endsWith("echo LAUNCHED"), command);

  // The flags the remote browser cannot work without. Each is quoted whole, so
  // a value can never be split by the shell.
  assert.match(command, /'--remote-debugging-port=9222'/);
  assert.match(command, /'--remote-debugging-address=127\.0\.0\.1'/);
  assert.match(command, /'--remote-allow-origins=\*'/);
  assert.match(command, /'--user-data-dir=\/kali-data\/chromium-home\/profile'/);
  assert.match(command, /'--no-sandbox'/);
  assert.match(command, /'--window-size=1280,800'/);
  assert.match(command, /'--proxy-server=http:\/\/127\.0\.0\.1:8080'/);
  assert.match(command, /export DISPLAY=':89'/);
  assert.match(command, /export HOME='\/kali-data\/chromium-home'/);

  // Stopping the previous browser must NOT be in here. This command carries
  // --remote-debugging-port on its own command line, so a `pkill -f` for that
  // pattern in the same shell matches the shell itself and kills it before it
  // reaches the launch — which showed up as "no output" and no browser, with
  // nothing to say why. It runs as its own SSH command instead.
  assert.ok(!command.includes("pkill"), command);

  // With no proxy, no proxy flag is passed at all.
  const direct = buildChromiumLaunchCommand({
    port: 9222,
    home: "/kali-data/chromium-home",
    display: ":89",
    screen: "1280x800x24",
  });
  assert.ok(!direct.includes("--proxy-server"), direct);
});

/**
 * A profile lock left by a container that no longer exists must be cleared, or
 * the browser can never start again.
 *
 * Found by recreating the attack box and watching every check fail at once.
 * Chromium's SingletonLock records the *hostname* of the machine holding it, and
 * the profile lives on a shared bind mount that outlives the container — so
 * after any attack-box replacement the lock names a host that is gone and
 * Chromium refuses to start at all:
 *
 *   The profile appears to be in use by another Chromium process (23323)
 *   on another computer (846f31541adc).
 *
 * Nothing clears it on its own, so every image update or `up -d --no-deps kali`
 * used to leave the Browser Agent permanently dead — and the message blames a
 * container that no longer exists, which points away from the real cause.
 */
test("the launch clears a profile lock left by a dead container", () => {
  const command = buildChromiumLaunchCommand({
    port: 9222,
    home: "/kali-data/chromium-home",
    display: ":89",
    screen: "1280x800x24",
  });

  assert.match(command, /rm -f [^;]*SingletonLock/);
  assert.match(command, /SingletonCookie/);
  assert.match(command, /SingletonSocket/);

  // Only the three lock files — the profile itself carries Burp's CA in its NSS
  // store, so removing the directory would silently undo the CA installation.
  assert.ok(
    !/rm -rf/.test(command),
    `the launch must not remove the profile directory: ${command}`,
  );
  assert.ok(!/rm -f [^;]*\/profile(?!\/Singleton)/.test(command), command);
});

test("the attack-box display is its own setting, not the backend's", () => {
  const previous = process.env.BROWSER_AGENT_DISPLAY;
  try {
    // The regression this guards: MAGNITUDE_DISPLAY names a display on the
    // backend (:99, its Xvfb). Passing that to the attack box makes Chromium
    // exit immediately with "Missing X server or $DISPLAY", because the attack
    // box's X server is the Xvnc desktop on :89.
    delete process.env.BROWSER_AGENT_DISPLAY;
    assert.equal(remoteBrowserDisplay(), ":89");

    process.env.BROWSER_AGENT_DISPLAY = "1";
    assert.equal(remoteBrowserDisplay(), ":1");
    process.env.BROWSER_AGENT_DISPLAY = ":12";
    assert.equal(remoteBrowserDisplay(), ":12");
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_DISPLAY;
    else process.env.BROWSER_AGENT_DISPLAY = previous;
  }
});

test("a remote launch never uses the backend's display", () => {
  withMode(true, () => {
    const { launch } = buildBrowserAgentConfig({
      ...baseConfig,
      display: ":99",
    });
    assert.equal(launch.display, ":89");
  });
  // Locally it still does — there is no attack box to draw on.
  withMode(false, () => {
    const { launch } = buildBrowserAgentConfig({
      ...baseConfig,
      display: ":99",
    });
    assert.equal(launch.display, ":99");
  });
});

test("unsupportedElementAction refuses what the element cannot do", () => {
  const el = (
    id: number,
    tag: string,
    role: string,
    name: string,
    ops: string[],
  ): DomElement => ({ id, tag, role, name, value: "", ops, disabled: false });

  const field = el(1, "input", "textbox", "Username", ["fill"]);
  const button = el(2, "button", "button", "Sign in", ["click"]);
  const checkbox = el(3, "input", "checkbox", "Accept terms", ["check"]);

  assert.equal(unsupportedElementAction(field, "fill"), null);
  assert.equal(unsupportedElementAction(button, "click"), null);
  assert.equal(unsupportedElementAction(checkbox, "check"), null);
  // Focusing a field and toggling through a label are both clicks.
  assert.equal(unsupportedElementAction(field, "click"), null);

  assert.match(
    unsupportedElementAction(button, "fill") ?? "",
    /does not support fill/,
  );
  assert.match(
    unsupportedElementAction(field, "select") ?? "",
    /does not support select/,
  );
  assert.match(
    unsupportedElementAction(field, "check") ?? "",
    /does not support check/,
  );
});

test("roleForLocator keeps ARIA roles and drops tag names", () => {
  assert.equal(roleForLocator("button"), "button");
  assert.equal(roleForLocator("TextBox"), "textbox");
  // A snapshot reports the tag name for anything without a role; getByRole("div")
  // throws, which is why these must not be used as roles.
  assert.equal(roleForLocator("div"), null);
  assert.equal(roleForLocator("label"), null);
  assert.equal(roleForLocator(""), null);
});

/**
 * The smallest page `runDomAction` can be run against: one locator that behaves
 * as asked, a fingerprint that changes, a url, and a CDP session that records
 * what was sent to it. Everything else the real driver does — actionability, the
 * navigation wait — is what these tests are about, so the fake reproduces only
 * the *outcomes* it produces.
 */
function fakePage(options: {
  click: () => Promise<void>;
  goto?: () => Promise<void>;
  url?: () => string;
  sent?: string[];
}): Parameters<typeof runDomAction>[0] {
  let revision = 0;
  const page = {
    url: () => options.url?.() ?? "http://target.test/login",
    // Answered for every evaluated block: the page-revision read wants a string
    // and the others ignore it.
    evaluate: async () => `http://target.test/login#1#${(revision += 1)}`,
    waitForLoadState: async () => {},
    goto: options.goto ?? (async () => {}),
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          options.sent?.push(method);
        },
        detach: async () => {},
      }),
    }),
    locator: () => {
      const locator: Record<string, unknown> = {
        count: async () => 1,
        click: options.click,
      };
      locator.first = () => locator;
      locator.nth = () => locator;
      return locator;
    },
  };
  return page as unknown as Parameters<typeof runDomAction>[0];
}

/** The driver's call log for a click that was delivered and then hung. */
function postActionNavigationTimeout(): Error {
  return new Error(
    "locator.click: Timeout 15000ms exceeded.\n" +
      "Call log:\n" +
      "  -   click action done\n" +
      "  -   waiting for scheduled navigations to finish\n",
  );
}

/**
 * A click that landed must not be reported as a failed action.
 *
 * The regression this guards, seen against the engagement target: the click
 * submitted a form, the response never came, and Playwright's post-click wait
 * for the scheduled navigation timed out — with the element found and the event
 * already delivered. The handler turned that into "Browser action failed", which
 * is wrong in both directions: it denies an action that happened, and it invites
 * the model to send the click again, submitting the form a second time.
 */
test("a click whose navigation never settled is reported as delivered, not failed", async () => {
  const sent: string[] = [];
  const line = await runDomAction(
    fakePage({
      click: async () => {
        throw postActionNavigationTimeout();
      },
      sent,
    }),
    { action: "click", locator: { css: "button" } },
    [],
  );

  assert.match(line, /click was delivered/);
  assert.match(line, /never committed/);
  assert.ok(!/failed/i.test(line), line);
  // The instruction that keeps a form from being submitted twice.
  assert.match(line, /do not repeat the action/i);
  // And the part that keeps the run alive. Without cancelling the stuck load,
  // every later read that needs the frame's execution context blocks behind the
  // navigation that never commits — measured on the attack box, where the page
  // stayed unreadable indefinitely.
  assert.deepEqual(sent, ["Page.stopLoading"]);
});

test("the page is left readable even when the recovery cannot be made", async () => {
  // No CDP session at all: the recovery is best-effort, and its absence must not
  // turn the report into a failure.
  const page = fakePage({
    click: async () => {
      throw postActionNavigationTimeout();
    },
  });
  (page as any).context = () => {
    throw new Error("no CDP here");
  };

  const line = await runDomAction(
    page,
    { action: "click", locator: { css: "button" } },
    [],
  );
  assert.match(line, /click was delivered/);
});

test("the delivered line reports where the page actually is", async () => {
  // The navigation committed but never finished loading: the page is the new
  // one, and saying "still on the old url" would be wrong.
  let url = "http://target.test/login";
  const line = await runDomAction(
    fakePage({
      click: async () => {
        url = "http://target.test/account/summary";
        throw postActionNavigationTimeout();
      },
      url: () => url,
    }),
    { action: "click", locator: { css: "button" } },
    [],
  );

  assert.match(line, /moved the page to http:\/\/target\.test\/account\/summary/);
  assert.match(line, /never finished loading/);
});

/**
 * The other half of the rule: only a *delivered* action is excused.
 *
 * An actionability timeout means the element was never found, so nothing was
 * clicked and nothing was submitted. Swallowing it would report a click that
 * never happened as having happened — the opposite mistake, and a worse one.
 */
test("a click that never reached its element still fails", async () => {
  await assert.rejects(
    runDomAction(
      fakePage({
        click: async () => {
          throw new Error(
            "locator.click: Timeout 15000ms exceeded.\n" +
              "Call log:\n" +
              '  - waiting for locator("button")\n' +
              "  -   locator resolved to hidden <button>Sign in</button>\n",
          );
        },
      }),
      { action: "click", locator: { css: "button" } },
      [],
    ),
    /Timeout 15000ms exceeded/,
  );
});

test("a navigation that never commits is still a failure", async () => {
  // `navigate` carries no `action done` line: the navigation *was* the action,
  // and it did not happen. This must keep propagating to the handler, which is
  // what appends the reachability hint.
  await assert.rejects(
    runDomAction(
      fakePage({
        click: async () => {},
        goto: async () => {
          throw new Error(
            "page.goto: Timeout 15000ms exceeded.\n" +
              "Call log:\n" +
              '  - navigating to "http://target.test/", waiting until "domcontentloaded"\n',
          );
        },
      }),
      { action: "navigate", url: "http://target.test/" },
      [],
    ),
    /page\.goto: Timeout 15000ms exceeded/,
  );
});

/**
 * Stopping the remote agent has to kill the browser on the attack box, not just
 * disconnect from it.
 *
 * This was a real defect, found by measurement rather than by reading: after
 * `browser.close()` returned, the Chromium process was still running on the
 * attack box — still holding its memory, its profile and its connection to the
 * proxy — so every "released" browser outlived the run that started it, with
 * nothing left able to reconnect. Playwright does not terminate a browser
 * attached with `connectOverCDP()`, so the kill is part of the stop path.
 *
 * A source guard, because the honest proof needs an attack box: the live check
 * (`scripts/browser-remote-check.ts`) asserts the process is actually gone after
 * stop. This only catches the kill being deleted again.
 */
test("the remote browser is killed on the attack box, not merely disconnected from", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "browser-agent.service.ts"),
    "utf8",
  );
  const start = source.indexOf("async function startRemoteAgent");
  assert.ok(start > -1, "startRemoteAgent is missing from browser-agent.service.ts");

  const stopPath = source.slice(start, start + 3_000);
  // Anchored to the exact sequence inside stop(), not just "a kill appears
  // somewhere nearby": startRemoteAgent has three kill calls (tunnel failure,
  // stop, and the catch that cleans up after an error), so a looser match would
  // keep passing after the one in stop() was deleted.
  assert.match(
    stopPath,
    /async stop\(\): Promise<void>[\s\S]*?await killRemoteChromium\(port\);\s*\n\s*tunnel\.close\(\);/,
    "startRemoteAgent's stop() no longer kills the remote Chromium before closing the tunnel",
  );
});
