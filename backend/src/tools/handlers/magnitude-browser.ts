import { ToolDefinition, ToolResult } from "../types";
import { readEnvFile } from "../../utils/envWriter";
import { browserActionSafetyDetail } from "../../utils/consentDetail";
import {
  formatMagnitudeError,
  isTransientBrowserLlmFailure,
  browserLlmErrorHint,
} from "../../utils/magnitudeError";
import { presetToProviderConfig } from "../../utils/llm/providers";
import { getAssignedModels } from "../../utils/modelRegistryStore";
import { isSubscriptionProvider } from "../../services/subscription-inference.service";
import { isHostOwner } from "../../services/host-owner.service";
import { resolveMagnitudeLlmConfig } from "../../utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  runBrowserAgentExclusive,
  scheduleBrowserAgentIdleStop,
  stopBrowserAgent,
} from "../../services/browser-agent.service";
import { newScreenshotName, saveSessionScreenshot } from "../../services/artifacts.service";
import { z } from "zod";

const magnitudeBrowser: ToolDefinition = {
  name: "browser_action",
  description:
    "Agentic browser action via the Magnitude browser agent: fill forms, click, navigate, extract data - " +
    "the agent interprets the page and carries out the goal autonomously. Requires Magnitude in Settings. " +
    "It acts on the real application: destructive goals (delete, overwrite, disable) are refused outright (proof of concept only - see <rules_of_engagement>; verify the control is missing and stop).",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to navigate to before the action.",
      },
      goal: {
        type: "string",
        description:
          "What to do in the browser, e.g. Log in with admin/admin and open the user management page.",
      },
      extract: {
        type: "string",
        description:
          "Data to extract from the page after the action, e.g. all usernames and emails from the table.",
      },
      screenshot: {
        type: "boolean",
        description: "Capture a PNG to show in chat after the action (default true).",
      },
    },
    required: ["url", "goal"],
  },
  /**
   * Configuration gate shared by the schema filter and the run path: without
   * it the model would see browser_action only to burn a turn on the refusal.
   * Per-user authorization (host CLI subscriptions) stays in execute.
   */
  async checkReady() {
    const env = readEnvFile();
    if (env.MAGNITUDE_ENABLED !== "true") {
      return "Magnitude browser agent is not enabled. Enable it in Settings -> Browser Agent.";
    }
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
  requiresConsent: true,
  shouldRequireConsent(args, ctx) {
    return browserActionSafetyDetail(args, ctx) !== undefined;
  },
  describeSafety(args, ctx) {
    return browserActionSafetyDetail(args, ctx);
  },
  timeoutMs: 300_000,
  async execute(args, ctx): Promise<ToolResult> {
    const { url, goal, extract } = args;

    if (!url || !goal) {
      return {
        output: "Error: both url and goal are required",
        exitCode: 1,
      };
    }

    const env = readEnvFile();

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

    const proxyUrl = env.MAGNITUDE_PROXY_URL || "";
    const headless = env.MAGNITUDE_HEADLESS !== "false";
    const display = env.MAGNITUDE_DISPLAY || process.env.DISPLAY || ":99";
    const normalizedDisplay = display.startsWith(":") ? display : `:${display}`;

    // Always ensure DISPLAY is set for the process.
    process.env.DISPLAY = normalizedDisplay;

    // A provider hiccup (429 / 5xx) on the browser agent LLM kills the whole
    // run, so retry transient failures with a backoff instead of handing the
    // caller an error a second call would have survived. 404s are not retried:
    // the model is gone from the provider and only a different assignment helps.
    const MAX_ATTEMPTS = 3;

    try {
      const llm = await resolveMagnitudeLlmConfig(
        providerConfig,
        browserModel.reasoningMode,
      );
      const { fingerprint, agentConfig } = buildBrowserAgentConfig({
        llm,
        headless,
        proxyUrl,
        display: normalizedDisplay,
        screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
      });

      for (let attempt = 1; ; attempt++) {
        try {
          const result = await runBrowserAgentExclusive(async () => {
            // The shared agent keeps its Chromium warm between calls, so a
            // second browser_action pays no cold start; only navigate + act.
            const agent = await ensureBrowserAgent(fingerprint, agentConfig);
            await agent.nav(url);
            await agent.act(goal);

            let extractedData = "";
            if (extract) {
              const data = await agent.extract(extract, z.record(z.any()));
              extractedData = `\n\nExtracted data:\n${JSON.stringify(data, null, 2)}`;
            }

            // Screenshot the final state so the user can see the page in chat.
            let files: string[] | undefined;
            let screenshotNote = "";
            if (args.screenshot !== false) {
              const shot = await saveSessionScreenshot(
                ctx.sessionId,
                newScreenshotName(),
                (filePath) =>
                  agent.page.screenshot({
                    path: filePath,
                    fullPage: false,
                  }),
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
              output: `Browser agent completed successfully.\nGoal: ${goal}\nURL: ${url}${extractedData}${screenshotNote}`,
              exitCode: 0,
              files,
            } as ToolResult;
          });

          scheduleBrowserAgentIdleStop();
          return result;
        } catch (agentError: any) {
          // A failed run can leave the browser in a bad state; drop it so the
          // retry (or the next call) starts from a clean context.
          await runBrowserAgentExclusive(stopBrowserAgent);
          const message = String(agentError?.message ?? agentError);
          if (attempt < MAX_ATTEMPTS && isTransientBrowserLlmFailure(message)) {
            await new Promise((resolve) =>
              setTimeout(resolve, attempt * 10_000),
            );
            continue;
          }
          return {
            output:
              `Browser agent failed during execution: ${formatMagnitudeError(agentError)}` +
              browserLlmErrorHint(message, browserModel.label),
            exitCode: 1,
          };
        }
      }
    } catch (err: any) {
      return {
        output: `Failed to start Magnitude browser agent: ${formatMagnitudeError(err)}`,
        exitCode: 1,
      };
    }
  },
};

export default magnitudeBrowser;
