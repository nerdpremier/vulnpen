import { ToolDefinition, ToolResult } from "../types";
import { resolveDynamicSetting } from "../../utils/envWriter";
import { browserActionSafetyDetail } from "../../utils/consentDetail";
import {
  formatMagnitudeError,
  browserLlmErrorHint,
  browserReachabilityHint,
} from "../../utils/magnitudeError";
import { presetToProviderConfig } from "../../utils/llm/orchestrator";
import { getAssignedModels } from "../../utils/modelRegistryStore";
import { isSubscriptionProvider } from "../../services/subscription-inference.service";
import { isHostOwner } from "../../services/host-owner.service";
import { resolveMagnitudeLlmConfig } from "../../utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  probeBrowserProxy,
  runBrowserAgentExclusive,
  scheduleBrowserAgentIdleStop,
  stopBrowserAgent,
} from "../../services/browser-agent.service";
import {
  snapshotPage,
  runDomAction,
  pageIsAlive,
  type DomElement,
} from "../../services/dom-browser.service";
import { newScreenshotName, saveSessionScreenshot } from "../../services/artifacts.service";

/**
 * Browser automation driven by the DOM, not by a screenshot.
 *
 * The browser runs on the attack box, launched over SSH and driven over CDP
 * through a loopback-only tunnel (services/remote-browser.service.ts), so it
 * shares that box's route to the target — the VPN connected there and the egress
 * fence every packet leaves through.
 *
 * Magnitude's bundled agent loop locates every click target as coordinates
 * through a small vision model (Moondream), which forces the Browser Agent model
 * to be vision-capable and makes each action a screen-space guess. This tool
 * borrows only the browser — the warm Chromium, the Burp proxy, the persistent
 * profile — and issues actions through Playwright's DOM API against its `page`,
 * so elements are addressed by role and accessible name.
 *
 * No screenshot is taken as part of the action loop. `screenshot: true` still
 * captures the final page for the transcript, but nothing reads it back.
 *
 * Magnitude's loop is not reachable from here at all — `tests/visionFreeBrowser.
 * test.ts` fails if a call to it appears anywhere under `src/` or `scripts/` — so
 * the browser agent has no vision dependency: the assigned model only has to
 * exist, not to be able to see.
 */
const magnitudeBrowser: ToolDefinition = {
  name: "browser_action",
  description:
    "Drive a real browser with DOM-level actions: navigate, snapshot the page's interactive elements, " +
    "then click / fill / select / press by element id. Use `action: \"snapshot\"` first to get the numbered " +
    "element table, then act on those ids. No screenshots are involved — the page is read as DOM, not as an image. " +
    "It acts on the real application: destructive goals (delete, overwrite, disable) stop for operator approval " +
    "(proof of concept only - see <rules_of_engagement>; verify the control is missing and stop).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "snapshot",
          "navigate",
          "click",
          "fill",
          "select",
          "press",
          "check",
          "wait_for",
          "extract_text",
          "back",
          "forward",
          "reload",
          "scroll",
        ],
        description:
          "What to do. `snapshot` reads the page (always do this first, and again after anything changes it). " +
          "`navigate` opens a url. `click`/`fill`/`select`/`press`/`check`/`wait_for` act on an element. " +
          "`extract_text` returns the page's visible text. `back`/`forward`/`reload`/`scroll` need no element.",
      },
      url: {
        type: "string",
        description: "URL to open. Required for `navigate`.",
      },
      element_id: {
        type: "number",
        description:
          "The element number from the most recent `snapshot`. Ids are only valid for that snapshot — " +
          "take a new snapshot after the page changes.",
      },
      locator: {
        type: "object",
        description:
          "Find an element directly instead of by snapshot id. Useful when you know the label. " +
          "Provide exactly one of role (+name), label, placeholder, test_id, text or css.",
        properties: {
          role: {
            type: "string",
            description:
              "ARIA role, e.g. button, link, textbox, checkbox, combobox. Combine with `name`.",
          },
          name: {
            type: "string",
            description: "Accessible name for the role, e.g. \"Sign in\".",
          },
          label: { type: "string", description: "Form field label text." },
          placeholder: { type: "string", description: "Input placeholder text." },
          test_id: { type: "string", description: "data-testid value." },
          text: { type: "string", description: "Visible text of the element." },
          css: { type: "string", description: "CSS selector, as a last resort." },
          nth: {
            type: "number",
            description: "Which match to use when several match (0-based). Default 0.",
          },
        },
      },
      value: {
        type: "string",
        description:
          "The text for `fill`, the option label for `select`, or the text to await for `wait_for`.",
      },
      key: {
        type: "string",
        description: "Key for `press`, e.g. Enter, Tab, Escape. Defaults to Enter.",
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Scroll direction. Default down.",
      },
      amount: {
        type: "number",
        description: "Pixels to scroll. Default 800.",
      },
      max_chars: {
        type: "number",
        description:
          "Cap on returned page text for `snapshot` / `extract_text`. Default 6000. " +
          "An action's own state read is always capped at 1000 chars. Raise it to see full pages; be aware it costs context.",
      },
      goal: {
        type: "string",
        description:
          "Describe the intended outcome (e.g. 'disable the user account', 'delete a test record', 'reset the admin password'). " +
          "The intent is checked against the destructive-goal detector; true destructive goals are refused.",
      },
      timeout_ms: {
        type: "number",
        description: "How long to wait for the element or navigation. Default 15000.",
      },
      screenshot: {
        type: "boolean",
        description:
          "Capture a PNG of the final page to show in chat (default false). The image is for the " +
          "operator reading the transcript; the action loop never reads it.",
      },
    },
    required: ["action"],
  },
  /**
   * Configuration gate shared by the schema filter and the run path: without it
   * the model would see browser_action only to burn a turn on the refusal.
   * Per-user authorization (host CLI subscriptions) stays in execute.
   */
  async checkReady() {
    if (resolveDynamicSetting("MAGNITUDE_ENABLED") !== "true") {
      return "The browser agent is not enabled. Enable it in Settings -> Browser Agent.";
    }
    // This path reads the DOM and never sends an image, so the assigned model
    // does not have to be vision-capable — but it still has to exist, because
    // Magnitude builds its client from it before we borrow the page.
    const browserModel = getAssignedModels().browser;
    if (!browserModel) {
      return "No Browser Agent model selected. Assign one in Settings -> Models.";
    }
    if (!browserModel.verifiedAt) {
      return "The Browser Agent model is unverified. Test and save it in Settings -> Models.";
    }
    const { apiKey } = await presetToProviderConfig(browserModel);
    if (!apiKey) {
      return "The selected Browser Agent model has no API key. Configure it in Settings -> Models.";
    }
    return undefined;
  },
  // This tool asks through its boundary verdict, not through a mode flag: a
  // browser goal the boundary flags stops in both modes.
  describeSafety(args, ctx) {
    return browserActionSafetyDetail(args, ctx);
  },
  timeoutMs: 120_000,
  async execute(args, ctx): Promise<ToolResult> {
    const action = args.action;
    if (!action) {
      return { output: "Error: action is required", exitCode: 1 };
    }

    // checkReady (configuration) already ran on the run path, so the model is
    // assigned, verified and carries a key; what is left here is per-user
    // authorization: host CLI subscriptions are reserved for the owner.
    const browserModel = getAssignedModels().browser;
    if (!browserModel) {
      return {
        output: "No Browser Agent model selected. Assign one in Settings -> Models.",
        exitCode: 1,
      };
    }
    if (isSubscriptionProvider(browserModel.provider)) {
      const hostOwner = ctx.userId ? await isHostOwner(ctx.userId) : false;
      if (!hostOwner) {
        return {
          output:
            "The selected Browser Agent model uses a host CLI subscription reserved for the installation owner.",
          exitCode: 1,
        };
      }
    }

    const providerConfig = await presetToProviderConfig(browserModel);

    // Through resolveDynamicSetting, not readEnvFile: the proxy the browser is
    // launched with has to be the one the deployment declares. Reading the file
    // raw let a stale `.env` line point the browser at a listener that cannot
    // leave the attack box — see the note on resolveDynamicSetting().
    const proxyUrl = resolveDynamicSetting("MAGNITUDE_PROXY_URL");
    const headless = resolveDynamicSetting("MAGNITUDE_HEADLESS") !== "false";
    const display =
      resolveDynamicSetting("MAGNITUDE_DISPLAY") || process.env.DISPLAY || ":99";
    const normalizedDisplay = display.startsWith(":") ? display : `:${display}`;

    // Always ensure DISPLAY is set for the process.
    process.env.DISPLAY = normalizedDisplay;

    // A proxy nothing answers on turns every navigation into a hang. The probe
    // is made on the attack box, where the browser actually runs, so it reports
    // what the browser will experience. Refuse before launching Chromium rather
    // than after it stalls.
    const proxyProblem = await probeBrowserProxy(proxyUrl);
    if (proxyProblem) {
      return { output: proxyProblem, exitCode: 1 };
    }

    let llm;
    try {
      llm = await resolveMagnitudeLlmConfig(
        providerConfig,
        browserModel.reasoningMode,
      );
    } catch (err: any) {
      return {
        output: `Failed to configure the browser agent: ${formatMagnitudeError(err)}`,
        exitCode: 1,
      };
    }

    const { fingerprint, agentConfig, launch } = buildBrowserAgentConfig({
      llm,
      headless,
      proxyUrl,
      display: normalizedDisplay,
      screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
    });

    try {
      return await runBrowserAgentExclusive(async () => {
        const agent = await ensureBrowserAgent(fingerprint, agentConfig, launch);
        const page = agent.page;
        if (!pageIsAlive(page)) {
          // The shared browser died between calls; rebuild once and retry.
          await stopBrowserAgent();
          const fresh = await ensureBrowserAgent(fingerprint, agentConfig, launch);
          return executeOnPage(fresh.page, args, ctx);
        }
        return executeOnPage(page, args, ctx);
      });
    } catch (agentError: any) {
      // A failed run can leave the browser in a bad state; drop it so the next
      // call starts from a clean context.
      await runBrowserAgentExclusive(stopBrowserAgent);
      const message = String(agentError?.message ?? agentError);
      return {
        output:
          `Browser action failed: ${formatMagnitudeError(agentError)}` +
          browserLlmErrorHint(message, browserModel.label) +
          browserReachabilityHint(message),
        exitCode: 1,
      };
    } finally {
      scheduleBrowserAgentIdleStop();
    }
  },
};

/**
 * How much page text an action's own state read returns. The element table is
 * what the model acts on; the text is only there to show what changed, and a
 * whole page of prose per action is what pushed long browser flows into
 * summarization mid-run.
 */
const AFTER_ACTION_TEXT_CHARS = 1000;

/**
 * The last element table sent for each page. An action that changed nothing
 * re-sends nothing: the ids in the previous read are still the ids on the page,
 * and repeating the same 120 rows on every step of a flow is pure context cost.
 */
const lastTableByPage = new WeakMap<object, string>();

/**
 * Carry out one action against a live page. Split out so the dead-page retry
 * above can run the exact same code on the rebuilt browser.
 */
async function executeOnPage(
  page: any,
  args: Record<string, any>,
  ctx: { sessionId: string },
): Promise<ToolResult> {
  const action = args.action as string;

  // The current element list is only needed to resolve an element_id, and the
  // id lookup has to be honest about the page as it is now. Actions that take a
  // locator (or no element at all) do not pay for the read.
  let elements: DomElement[] = [];
  const needsElements =
    action === "snapshot" || typeof args.element_id === "number";

  let snapshot;
  if (needsElements) {
    snapshot = await snapshotPage(page, args.max_chars ?? 6000);
    elements = snapshot.elements;
  }

  if (action === "snapshot") {
    const header = `Page: ${snapshot!.title || "(untitled)"}\nURL: ${snapshot!.url}`;
    lastTableByPage.set(page, snapshot!.table);
    return {
      output:
        `${header}\n\nInteractive elements (${elements.length}):\n${snapshot!.table}` +
        `\n\nVisible text:\n${snapshot!.text}`,
      exitCode: 0,
    };
  }

  const resultLine = await runDomAction(page, args as any, elements);

  // Read the resulting state so the model does not have to spend a turn on it.
  // A nav-heavy action changes the page, so its element ids are stale.
  //
  // The read is allowed to fail without failing the action. A page that is
  // mid-navigation cannot be read back, and turning that into "Browser action
  // failed" reports a click that landed as a click that did not — which invites
  // the model to send it again, and on a form that is a second submission.
  let readFailure = "";
  const after = await snapshotPage(page, AFTER_ACTION_TEXT_CHARS).catch(
    (err: any) => {
      readFailure = String(err?.message ?? err);
      return null;
    },
  );

  if (!after) {
    // No screenshot either: a page that cannot be read back is mid-navigation,
    // and waiting for one to render is the very hang this path exists to avoid.
    return {
      output:
        `${resultLine}\n\nThe page could not be read back after the action ` +
        `(${readFailure}). The action itself was carried out — take a snapshot ` +
        "before the next step.",
      exitCode: 0,
    };
  }

  const tableChanged = lastTableByPage.get(page) !== after.table;
  if (tableChanged) lastTableByPage.set(page, after.table);
  const tableBlock = tableChanged
    ? `Interactive elements (${after.elements.length}):\n${after.table}`
    : `Interactive elements: unchanged (${after.elements.length}) — the same ids as the ` +
      "previous read. If you no longer have that table, run action: \"snapshot\".";

  let files: string[] | undefined;
  let screenshotNote = "";
  if (args.screenshot === true) {
    const shot = await saveSessionScreenshot(
      ctx.sessionId,
      newScreenshotName(),
      (filePath: string) =>
        page.screenshot({ path: filePath, fullPage: false }),
    );
    if (shot.ok) {
      files = [shot.fileName];
      screenshotNote = `\n\nScreenshot captured: ${shot.fileName} (shown to the user in the chat).`;
    } else {
      const shotErr: any = shot.error;
      screenshotNote = `\n\nScreenshot failed: ${shotErr?.message ?? shotErr}`;
    }
  }

  return {
    output:
      `${resultLine}\n\nPage: ${after.title || "(untitled)"}\nURL: ${after.url}\n\n` +
      `${tableBlock}\n\nVisible text:\n${after.text}${screenshotNote}`,
    exitCode: 0,
    files,
  };
}

export default magnitudeBrowser;
