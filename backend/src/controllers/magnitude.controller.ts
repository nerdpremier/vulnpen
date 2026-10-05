import { Response, Request } from "express";
import { formatMagnitudeError } from "../utils/magnitudeError";
import {
  getBrowserAgentDisplay,
  getBrowserAgentRfbPort,
  getBrowserAgentNovncPort,
} from "../config/constants";
import { isPortListening } from "../utils/tcpProbe";
import { presetToProviderConfig } from "../utils/llm/orchestrator";
import { isSubscriptionProvider } from "../services/subscription-inference.service";
import { setBrowserModel } from "../services/model-settings.service";
import { resolveMagnitudeLlmConfig } from "../utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  runBrowserAgentExclusive,
  scheduleBrowserAgentIdleStop,
  stopBrowserAgent,
} from "../services/browser-agent.service";
import {
  getAssignedModels,
  readModelRegistry,
} from "../utils/modelRegistryStore";
import { isHostOwner } from "../services/host-owner.service";
import { readEnvFile, updateEnvVars } from "../utils/envWriter";

export const getMagnitudeConfig = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    const modelRegistry = readModelRegistry();
    const owner = await isHostOwner(res.locals.userId);
    const browserModel = modelRegistry.models.find(
      (model) => model.id === modelRegistry.assignments.browserModelId,
    );
    const visibleModels = owner
      ? modelRegistry.models
      : modelRegistry.models.filter(
          (model) => !isSubscriptionProvider(model.provider),
        );
    const visibleBrowserModel =
      browserModel &&
      (owner || !isSubscriptionProvider(browserModel.provider))
        ? browserModel
        : null;

    return res.status(200).json({
      enabled: env.MAGNITUDE_ENABLED === "true",
      proxyUrl: env.MAGNITUDE_PROXY_URL || "",
      headless: env.MAGNITUDE_HEADLESS !== "false",
      displayPort: env.MAGNITUDE_DISPLAY || "",
      configured: env.MAGNITUDE_ENABLED === "true",
      browserModelId: visibleBrowserModel?.id || "",
      browserModel: visibleBrowserModel,
      models: visibleModels,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get Magnitude config" });
  }
};

export const updateMagnitudeConfig = async (req: Request, res: Response) => {
  try {
    const { enabled, proxyUrl, headless, displayPort, browserModelId } =
      req.body;

    if (
      browserModelId !== undefined &&
      !(await isHostOwner(res.locals.userId))
    ) {
      return res.status(403).json({
        message:
          "Only the installation owner can change the host Browser Agent model assignment",
      });
    }

    const updates: Record<string, string> = {
      MAGNITUDE_ENABLED: String(!!enabled),
      MAGNITUDE_HEADLESS: String(headless !== false),
    };

    if (proxyUrl !== undefined) {
      updates.MAGNITUDE_PROXY_URL = proxyUrl || "";
    }

    if (displayPort !== undefined) {
      updates.MAGNITUDE_DISPLAY = displayPort || "";
    }

    updateEnvVars(updates);
    // Rebuilding the shared browser is lazy, but release a live one when the
    // agent is switched off so it is not left running in the background.
    if (!enabled) {
      void runBrowserAgentExclusive(stopBrowserAgent);
    }

    if (browserModelId !== undefined) {
      setBrowserModel(browserModelId);
    }

    return res.status(200).json({ message: "Magnitude configuration updated" });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to update Magnitude config" });
  }
};

// The browser agent is shared with the orchestrator browser_action tool, so a
// run started here and one started from chat reuse the same warm Chromium
// instead of each cold-starting their own (see browser-agent.service.ts).
export const startMagnitudeAgent = async (req: Request, res: Response) => {
  try {
    const { goal, targetUrl } = req.body;

    if (!goal) {
      return res
        .status(400)
        .json({ message: "A goal is required to start the browser agent" });
    }

    if (!targetUrl) {
      return res.status(400).json({ message: "A target URL is required" });
    }

    const env = readEnvFile();

    if (env.MAGNITUDE_ENABLED !== "true") {
      return res.status(400).json({
        message:
          "Magnitude browser agent is not enabled. Enable it in Settings -> Browser Agent.",
      });
    }

    const browserModel = getAssignedModels().browser;
    if (!browserModel) {
      return res.status(400).json({
        message:
          "No Browser Agent model selected. Assign one in Settings -> Models.",
      });
    }
    if (!browserModel.verifiedAt) {
      return res.status(400).json({
        message:
          "The Browser Agent model is unverified. Test and save it in Settings -> Models.",
      });
    }

    if (
      isSubscriptionProvider(browserModel.provider) &&
      !(await isHostOwner(res.locals.userId))
    ) {
      return res.status(403).json({
        message:
          "The selected Browser Agent model uses a host CLI subscription reserved for the installation owner",
      });
    }

    const providerConfig = await presetToProviderConfig(browserModel);
    const { apiKey } = providerConfig;
    const proxyUrl = env.MAGNITUDE_PROXY_URL || "";
    const headless = env.MAGNITUDE_HEADLESS !== "false";
    const display = env.MAGNITUDE_DISPLAY || getBrowserAgentDisplay();
    const normalizedDisplay = display.startsWith(":") ? display : `:${display}`;

    if (!apiKey) {
      return res.status(400).json({
        message:
          "The selected Browser Agent model has no API key. Configure it in Settings -> Models.",
      });
    }

    // Always ensure DISPLAY is set for the process
    process.env.DISPLAY = normalizedDisplay;

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

    try {
      await runBrowserAgentExclusive(async () => {
        const agent = await ensureBrowserAgent(fingerprint, agentConfig);
        await agent.nav(targetUrl);
        await agent.act(goal);
      });
    } catch (agentError: any) {
      // A failed run can leave the browser in a bad state; drop it so the next
      // run starts from a clean context instead of inheriting the wreckage.
      await runBrowserAgentExclusive(stopBrowserAgent);
      return res.status(500).json({
        message: `Browser agent failed: ${formatMagnitudeError(agentError)}`,
        goal,
        targetUrl,
      });
    }

    // Kept open on purpose - the live view shows the final browser state until
    // the next run reuses it (or the idle timeout releases it).
    scheduleBrowserAgentIdleStop();
    return res.status(200).json({
      message: "Browser agent completed the goal successfully",
      goal,
      targetUrl,
    });
  } catch (error: any) {
    console.log(error);
    return res.status(500).json({
      message: `Failed to start Magnitude agent: ${formatMagnitudeError(error)}`,
    });
  }
};

export const getBrowserAgentVNC = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    const magnitudeEnabled = env.MAGNITUDE_ENABLED === "true";
    const headless = env.MAGNITUDE_HEADLESS !== "false";
    const display = env.MAGNITUDE_DISPLAY || getBrowserAgentDisplay();
    const novncPort = String(getBrowserAgentNovncPort());

    const fs = await import("fs");
    const inDocker = fs.existsSync("/.dockerenv");

    // Probe the stack instead of assuming it is up because we are in Docker.
    // x11vnc dies whenever Xvfb fails, which leaves websockify happily serving
    // the noVNC page with nothing behind it — the client then renders a bare
    // "Failed to connect to server" with no explanation.
    const [rfbUp, novncUp] = inDocker
      ? await Promise.all([
          isPortListening(getBrowserAgentRfbPort()),
          isPortListening(getBrowserAgentNovncPort()),
        ])
      : [false, false];

    const vncRunning = inDocker && rfbUp && novncUp;

    return res.status(200).json({
      // `available` stays config-intent (headed mode requested); `vncRunning`
      // reports whether the stream is actually serviceable right now.
      available: magnitudeEnabled && !headless,
      enabled: magnitudeEnabled,
      headless,
      display,
      novncPort,
      vncRunning,
      rfbUp,
      novncUp,
      mode: inDocker ? "docker" : "dev",
    });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to get Browser Agent VNC config" });
  }
};
