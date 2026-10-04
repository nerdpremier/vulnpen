/**
 * Shared, long-lived Magnitude browser agent.
 *
 * Magnitude launches a fresh Chromium for every `startBrowserAgent()` call and
 * `agent.stop()` closes the context - and with it the whole browser once its
 * last context goes away (see BrowserProvider in magnitude-core). The
 * orchestrator browser_action tool used to create and tear down an agent on
 * every invocation, paying the full browser cold-start each time even when the
 * same engagement kept hitting the same target.
 *
 * This module owns ONE agent for the process. Callers obtain it through
 * ensureBrowserAgent(), which transparently reuses the live agent while its
 * configuration fingerprint is unchanged and rebuilds it when the Browser Agent
 * model, reasoning, proxy, headless mode, or screen size changes. Runs are
 * serialized with runBrowserAgentExclusive() because a Magnitude agent can only
 * drive one goal at a time.
 */
import { getBurpBrowserHome } from "./burp-ca.service";
import type { MagnitudeLlmConfig } from "../utils/magnitudeLlm";

export interface BrowserAgentRuntimeConfig {
  llm: MagnitudeLlmConfig;
  headless: boolean;
  proxyUrl: string;
  display: string;
  screen: string;
}

const DEFAULT_SCREEN = "1280x800x24";
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

/** Milliseconds the browser may sit idle before it is released. 0 disables. */
function idleTimeoutMs(): number {
  const raw = Number(process.env.BROWSER_AGENT_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return raw;
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
 * Build the magnitude-core agent config and the fingerprint that decides when a
 * live agent can be reused. The fingerprint covers everything baked into a
 * running agent (LLM client, headless mode, proxy, display, viewport), so a
 * settings change forces a rebuild on the next run instead of silently keeping
 * the old configuration.
 */
export function buildBrowserAgentConfig(config: BrowserAgentRuntimeConfig): {
  fingerprint: string;
  agentConfig: any;
} {
  const viewport = parseViewport(config.screen);
  const browserEnv = {
    ...process.env,
    HOME: getBurpBrowserHome(),
    ...(config.headless ? {} : { DISPLAY: config.display }),
  };
  const launchOptions: any = { headless: config.headless, env: browserEnv };
  if (config.proxyUrl) {
    launchOptions.proxy = { server: config.proxyUrl };
  }
  if (!config.headless) {
    // No window manager runs on the Xvfb display, so --start-maximized is a
    // no-op; size the window to the screen explicitly.
    launchOptions.args = [`--window-size=${viewport.width},${viewport.height}`];
  }

  const fingerprint = JSON.stringify({
    provider: config.llm.provider,
    model: config.llm.options.model,
    baseUrl: config.llm.options.baseUrl ?? "",
    apiKey: config.llm.options.apiKey,
    headless: config.headless,
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

  return { fingerprint, agentConfig };
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
 * Return the live shared agent, creating (or recreating) it when the
 * fingerprint changes. Always call inside runBrowserAgentExclusive().
 */
export async function ensureBrowserAgent(
  fingerprint: string,
  agentConfig: any,
): Promise<any> {
  clearIdleTimer();
  if (activeAgent && activeFingerprint === fingerprint) {
    return activeAgent;
  }
  await stopBrowserAgent();
  const { startBrowserAgent } = await import("magnitude-core");
  const agent = await startBrowserAgent(agentConfig);
  activeAgent = agent;
  activeFingerprint = fingerprint;
  return agent;
}

/**
 * Serialize access to the shared agent. A Magnitude agent drives a single goal
 * at a time, so concurrent browser_action calls queue instead of interleaving.
 */
export function runBrowserAgentExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = runChain.then(fn, fn);
  runChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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

export function hasLiveBrowserAgent(): boolean {
  return activeAgent !== null;
}
