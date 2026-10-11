/**
 * Live check for the shared browser agent.
 *
 * Drives a REAL Chromium through the same code path the browser_action tool uses,
 * twice back-to-back, to prove the cold-start win: the first run pays for
 * launching Chromium and building the agent, the second reuses the live agent and
 * must hand back the same instance.
 *
 * The page is read and driven through the DOM path (snapshotPage / runDomAction)
 * and never through `agent.act()`. That loop locates every click target as a
 * coordinate through a small vision model, which is why VulnPen does not use it -
 * see services/dom-browser.service.ts. Nothing in this repository calls it, and
 * tests/visionFreeBrowser.test.ts keeps it that way, so the assigned Browser
 * Agent model is only ever used to construct Magnitude's client: a text-only
 * model is enough, and no screenshot is taken or read anywhere in this script.
 *
 * Run: npx tsx scripts/browser-agent-live-check.ts
 * Launches a real browser; it is a script, not part of `npm test`.
 */
import { loadConfig } from "../src/utils/loadConfig";
import { readEnvFile } from "../src/utils/envWriter";
import { getAssignedModels } from "../src/utils/modelRegistryStore";
import { presetToProviderConfig } from "../src/utils/llm/orchestrator";
import { resolveMagnitudeLlmConfig } from "../src/utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  runBrowserAgentExclusive,
  stopBrowserAgent,
} from "../src/services/browser-agent.service";
import { snapshotPage, runDomAction } from "../src/services/dom-browser.service";

const URL = process.env.BROWSER_CHECK_URL || "https://example.com";
const MAX_CHARS = 2_000;

async function main() {
  loadConfig();
  const env = readEnvFile();

  if (env.MAGNITUDE_ENABLED !== "true") {
    throw new Error("Magnitude is not enabled in backend/.env (MAGNITUDE_ENABLED)");
  }

  const model = getAssignedModels().browser;
  if (!model) throw new Error("No Browser Agent model assigned");
  if (!model.verifiedAt) throw new Error("Browser Agent model is not verified");

  const providerConfig = await presetToProviderConfig(model);
  if (!providerConfig.apiKey) {
    throw new Error("Browser Agent model has no API key");
  }

  const llm = await resolveMagnitudeLlmConfig(
    providerConfig,
    model.reasoningMode,
  );

  // Force headless and drop the Burp proxy for a LOCAL launch: neither the
  // container Xvfb display (:99) nor the kali proxy are reachable from the dev
  // host. Everything else mirrors the browser_action tool. With the default
  // remote launch these two are decided on the attack box instead, and the
  // values here are ignored.
  const { fingerprint, agentConfig, launch } = buildBrowserAgentConfig({
    llm,
    headless: true,
    proxyUrl: "",
    display: env.MAGNITUDE_DISPLAY || ":99",
    screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
  });

  // Point patchright at an already-installed Chromium when the exact revision
  // it expects is missing on this host (the container image installs it). Only
  // applies to a local launch — the remote browser is launched on the attack box.
  const executable = process.env.BROWSER_CHECK_EXECUTABLE;
  if (executable) {
    agentConfig.browser.launchOptions.executablePath = executable;
  }

  console.log(
    "\n=== Live browser-agent reuse check (model: " +
      model.label +
      " / " +
      model.model +
      ") ===",
  );

  let firstAgent: any = null;
  let secondAgent: any = null;
  let observed = "";

  const runOnce = async (capture: (agent: any) => void) => {
    const started = Date.now();
    await runBrowserAgentExclusive(async () => {
      const agent = await ensureBrowserAgent(fingerprint, agentConfig, launch);
      capture(agent);

      const page = agent.page;
      await runDomAction(page, { action: "navigate", url: URL }, []);

      // The same read the tool performs: one evaluate returns the indexed
      // controls plus the visible text. No image is captured or consumed.
      const snapshot = await snapshotPage(page, MAX_CHARS);
      if (!snapshot.elements.length && !snapshot.text) {
        throw new Error(`${URL} produced nothing to read as DOM`);
      }
      observed =
        `${snapshot.title || "(untitled)"} — ${snapshot.elements.length} interactive ` +
        `elements, ${snapshot.text.length} chars of text`;
    });
    return Date.now() - started;
  };

  const cold = await runOnce((a) => {
    firstAgent = a;
  });
  const warm = await runOnce((a) => {
    secondAgent = a;
  });

  const sameInstance = firstAgent !== null && firstAgent === secondAgent;
  const saved = cold - warm;
  const pct = cold > 0 ? (saved / cold) * 100 : 0;

  console.log("page read through the DOM path:          " + observed);
  console.log("cold run (first agent + Chromium launch): " + cold + " ms");
  console.log("warm run (reused live agent):            " + warm + " ms");
  console.log("same live agent reused:                   " + (sameInstance ? "YES" : "NO"));
  console.log(
    "reuse saved ~" + saved + " ms (" + pct.toFixed(1) + "% of the cold run)",
  );

  await stopBrowserAgent();
  console.log("shared agent stopped.");

  const ok = sameInstance && saved > 0;
  console.log("\nverdict: " + (ok ? "PASS" : "FAIL"));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("live check failed:", err);
  process.exit(1);
});
