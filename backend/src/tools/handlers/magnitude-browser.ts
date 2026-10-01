import { ToolDefinition, ToolResult } from "../types";
import { readEnvFile } from "../../utils/envWriter";
import { formatMagnitudeError } from "../../utils/magnitudeError";
import { presetToProviderConfig } from "../../utils/llm/providers";
import { getAssignedModels } from "../../utils/modelRegistryStore";
import { isSubscriptionProvider } from "../../services/subscription-inference.service";
import { isHostOwner } from "../../services/host-owner.service";
import { resolveMagnitudeLlmConfig } from "../../utils/magnitudeLlm";
import { getBurpBrowserHome } from "../../services/burp-ca.service";
import { getDataDir } from "../../utils/loadConfig";
import { z } from "zod";
import fs from "fs";
import path from "path";

const magnitudeBrowser: ToolDefinition = {
  name: "browser_action",
  description:
    "Perform an agentic browser action using the Magnitude browser agent. " +
    "Use this to interact with web applications during a penetration test — " +
    "e.g. filling forms, clicking buttons, navigating pages, extracting data. " +
    "The agent uses AI to interpret the page and carry out the goal autonomously. " +
    "Requires Magnitude to be enabled in Settings.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The target URL to navigate to before performing the action",
      },
      goal: {
        type: "string",
        description:
          "A natural-language description of what to do in the browser " +
          "(e.g. 'Log in with admin/admin and navigate to the user management page')",
      },
      extract: {
        type: "string",
        description:
          "Optional. A description of what data to extract from the page after performing the action " +
          "(e.g. 'Extract all usernames and email addresses from the table')",
      },
      screenshot: {
        type: "boolean",
        description:
          "Capture a PNG screenshot of the page after the action and show it to the user in the chat (default true).",
      },
    },
    required: ["url", "goal"],
  },
  requiresConsent: true,
  timeoutMs: 300_000,
  async execute(args, ctx): Promise<ToolResult> {
    const { url, goal, extract } = args;

    if (!url || !goal) {
      return {
        output: "Error: both 'url' and 'goal' are required",
        exitCode: 1,
      };
    }

    const env = readEnvFile();

    if (env.MAGNITUDE_ENABLED !== "true") {
      return {
        output:
          "Magnitude browser agent is not enabled. Enable it in Settings -> Browser Agent.",
        exitCode: 1,
      };
    }

    const browserModel = getAssignedModels().browser;
    if (!browserModel) {
      return {
        output:
          "No Browser Agent model selected. Assign one in Settings -> Models.",
        exitCode: 1,
      };
    }
    if (!browserModel.verifiedAt) {
      return {
        output:
          "The Browser Agent model is unverified. Test and save it in Settings -> Models.",
        exitCode: 1,
      };
    }

    if (
      isSubscriptionProvider(browserModel.provider) &&
      !(await isHostOwner(ctx.userId))
    ) {
      return {
        output:
          "The selected Browser Agent model uses a host CLI subscription reserved for the installation owner.",
        exitCode: 1,
      };
    }

    const providerConfig = await presetToProviderConfig(browserModel);
    const { apiKey } = providerConfig;
    const proxyUrl = env.MAGNITUDE_PROXY_URL || "";
    const headless = env.MAGNITUDE_HEADLESS !== "false";
    const display = env.MAGNITUDE_DISPLAY || process.env.DISPLAY || ":99";
    const normalizedDisplay = display.startsWith(":") ? display : `:${display}`;

    if (!apiKey) {
      return {
        output:
          "The selected Browser Agent model has no API key. Configure it in Settings → Models.",
        exitCode: 1,
      };
    }

    // Always ensure DISPLAY is set for the process
    process.env.DISPLAY = normalizedDisplay;

    try {
      const { startBrowserAgent } = await import("magnitude-core");
      const llm = await resolveMagnitudeLlmConfig(
        providerConfig,
        browserModel.reasoningMode,
      );

      const browserEnv = { ...process.env, HOME: getBurpBrowserHome() };
      const launchOptions: any = { headless, env: browserEnv };
      if (proxyUrl) {
        launchOptions.proxy = { server: proxyUrl };
      }
      // Magnitude merges an explicit deviceScaleFactor into every context, and
      // Playwright rejects deviceScaleFactor combined with viewport: null — so
      // the viewport must always be a real size. Size it to the Xvfb screen so
      // a headful browser fills the display.
      const [, screenW, screenH] =
        (process.env.BROWSER_AGENT_SCREEN || "1280x800x24").match(/^(\d+)x(\d+)/) || [];
      const viewport = {
        width: screenW ? Number(screenW) : 1280,
        height: screenH ? Number(screenH) : 800,
      };
      if (!headless) {
        // No window manager runs on the Xvfb display, so --start-maximized is a
        // no-op; size the window to the screen explicitly and render the page
        // at the same viewport so the whole screen is used.
        launchOptions.args = [`--window-size=${viewport.width},${viewport.height}`];
      }

      const agentConfig: any = {
        url,
        narrate: false,
        browser: {
          launchOptions,
          contextOptions: { ignoreHTTPSErrors: true, viewport },
        },
        llm: {
          provider: llm.provider,
          options: llm.options,
        },
      };

      const agent = await startBrowserAgent(agentConfig);

      try {
        await agent.act(goal);

        let extractedData = "";
        if (extract) {
          const data = await agent.extract(extract, z.record(z.any()));
          extractedData = `\n\nExtracted data:\n${JSON.stringify(data, null, 2)}`;
        }

        // Screenshot the final state so the user can see the page in the chat.
        let files: string[] | undefined;
        let screenshotNote = "";
        if (args.screenshot !== false) {
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const safeSession = (ctx.sessionId || "session").replace(/[^a-zA-Z0-9_-]/g, "_");
            const dir = path.join(getDataDir(), "screenshots", safeSession);
            fs.mkdirSync(dir, { recursive: true });
            const fileName = `${stamp}.png`;
            await agent.page.screenshot({ path: path.join(dir, fileName), fullPage: false });
            files = [fileName];
            screenshotNote = `\n\nScreenshot captured: ${fileName} (shown to the user in the chat).`;
          } catch (shotErr: any) {
            screenshotNote = `\n\nScreenshot failed: ${shotErr?.message ?? shotErr}`;
          }
        }

        await agent.stop();

        return {
          output: `Browser agent completed successfully.\nGoal: ${goal}\nURL: ${url}${extractedData}${screenshotNote}`,
          exitCode: 0,
          files,
        };
      } catch (agentError: any) {
        try {
          await agent.stop();
        } catch (stopError) {
          console.warn("Failed to stop Browser Agent after an error:", stopError);
        }
        return {
          output: `Browser agent failed during execution: ${formatMagnitudeError(agentError)}`,
          exitCode: 1,
        };
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
