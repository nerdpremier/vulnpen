/**
 * Live check for the shared browser agent.
 *
 * Drives the REAL assigned Browser Agent model and a real Chromium through the
 * same code path the browser_action tool uses, twice back-to-back, to prove the
 * cold-start win: the first run pays for launching Chromium and building the
 * agent, the second reuses the live agent and must hand back the same instance.
 *
 * Run: npx tsx scripts/browser-agent-live-check.ts
 * Costs a couple of provider calls and launches a real browser; it is a script,
 * not part of `npm test`.
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

const URL = process.env.BROWSER_CHECK_URL || "https://example.com";

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

  // Force headless and drop the Burp proxy for this host-run check: neither the
  // container Xvfb display (:99) nor the kali proxy are reachable from the dev
  // host. Everything else mirrors the browser_action tool.
  const { fingerprint, agentConfig } = buildBrowserAgentConfig({
    llm,
    headless: true,
    proxyUrl: "",
    display: env.MAGNITUDE_DISPLAY || ":99",
    screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
  });

  // Point patchright at an already-installed Chromium when the exact revision
  // it expects is missing on this host (the container image installs it).
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

  const runOnce = async (goal: string, capture: (agent: any) => void) => {
    const started = Date.now();
    await runBrowserAgentExclusive(async () => {
      const agent = await ensureBrowserAgent(fingerprint, agentConfig);
      capture(agent);
      await agent.nav(URL);
      await agent.act(goal);
    });
    return Date.now() - started;
  };

  const cold = await runOnce(
    "Report the main heading text of this page.",
    (a) => {
      firstAgent = a;
    },
  );
  const warm = await runOnce(
    "Report the text of the first link on this page.",
    (a) => {
      secondAgent = a;
    },
  );

  const sameInstance = firstAgent !== null && firstAgent === secondAgent;
  const saved = cold - warm;
  const pct = cold > 0 ? (saved / cold) * 100 : 0;

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
