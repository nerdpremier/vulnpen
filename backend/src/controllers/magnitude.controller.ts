import { Response, Request } from "express";
import { formatMagnitudeError } from "../utils/magnitudeError";
import { getBrowserAgentDisplay } from "../config/constants";
import { presetToProviderConfig } from "../utils/llm/orchestrator";
import { isSubscriptionProvider } from "../services/subscription-inference.service";
import { setBrowserModel } from "../services/model-settings.service";
import { resolveBrowserView } from "../services/browser-view.service";
import { resolveMagnitudeLlmConfig } from "../utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  probeBrowserProxy,
  runBrowserAgentExclusive,
  scheduleBrowserAgentIdleStop,
  stopBrowserAgent,
} from "../services/browser-agent.service";
import {
  getAssignedModels,
  readModelRegistry,
} from "../utils/modelRegistryStore";
import { isHostOwner } from "../services/host-owner.service";
import { isDeploymentPinned } from "../utils/loadConfig";
import { resolveDynamicSetting, updateEnvVars } from "../utils/envWriter";

export const getMagnitudeConfig = async (_req: Request, res: Response) => {
  try {
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

    // The *effective* values, not the raw file: the proxy the browser will be
    // launched with is resolved through the deployment's pin, and reporting the
    // file's value instead showed a setting the operator could edit and that
    // could never take effect.
    return res.status(200).json({
      enabled: resolveDynamicSetting("MAGNITUDE_ENABLED") === "true",
      proxyUrl: resolveDynamicSetting("MAGNITUDE_PROXY_URL"),
      // True when the deployment supplies the proxy, so the UI can say where it
      // comes from rather than offering an edit that would be ignored.
      proxyPinned: isDeploymentPinned("MAGNITUDE_PROXY_URL"),
      headless: resolveDynamicSetting("MAGNITUDE_HEADLESS") !== "false",
      displayPort: resolveDynamicSetting("MAGNITUDE_DISPLAY"),
      configured: resolveDynamicSetting("MAGNITUDE_ENABLED") === "true",
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

    if (resolveDynamicSetting("MAGNITUDE_ENABLED") !== "true") {
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
    const proxyUrl = resolveDynamicSetting("MAGNITUDE_PROXY_URL");
    const headless = resolveDynamicSetting("MAGNITUDE_HEADLESS") !== "false";
    const display =
      resolveDynamicSetting("MAGNITUDE_DISPLAY") || getBrowserAgentDisplay();
    const normalizedDisplay = display.startsWith(":") ? display : `:${display}`;

    if (!apiKey) {
      return res.status(400).json({
        message:
          "The selected Browser Agent model has no API key. Configure it in Settings -> Models.",
      });
    }

    // Always ensure DISPLAY is set for the process
    process.env.DISPLAY = normalizedDisplay;

    // Fail here rather than opening a browser that will hang on every request.
    const proxyProblem = await probeBrowserProxy(proxyUrl);
    if (proxyProblem) {
      return res.status(400).json({ message: proxyProblem });
    }

    const llm = await resolveMagnitudeLlmConfig(
      providerConfig,
      browserModel.reasoningMode,
    );
    const { fingerprint, agentConfig, launch } = buildBrowserAgentConfig({
      llm,
      headless,
      proxyUrl,
      display: normalizedDisplay,
      screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
    });

    try {
      await runBrowserAgentExclusive(async () => {
        const agent = await ensureBrowserAgent(fingerprint, agentConfig, launch);
        // Only the navigation is carried out here. The goal used to be handed to
        // agent.act(), which resolves every click target through a vision model;
        // that loop is now called nowhere in this repository (pinned by
        // tests/visionFreeBrowser.test.ts). This panel just opens the page in the
        // shared browser so the live view shows it, and the operator drives it
        // from there with the mouse and keyboard.
        //
        // `goal` is required because the caller states the intent, but nothing
        // here judges it: this is the operator's own browser on their own
        // workstation, the route is host-owner only, and the agent's
        // browser_action tool — which does pass its goal and URL through the
        // boundary — is not used on this path. The destination is still bound by
        // the egress fence, which judges the wire request rather than the words
        // in a goal.
        await agent.nav(targetUrl);
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
      message: `Browser opened at ${targetUrl}`,
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
    const magnitudeEnabled = resolveDynamicSetting("MAGNITUDE_ENABLED") === "true";
    const headless = resolveDynamicSetting("MAGNITUDE_HEADLESS") !== "false";

    const fs = await import("fs");
    const inDocker = fs.existsSync("/.dockerenv");

    // Which display to stream is not the backend's to assume: the browser runs
    // on the attack box whenever remote mode is on, and that box has its own
    // desktop on its own port. Resolving it here keeps the panel pointing at
    // the screen the agent is actually on.
    const view = await resolveBrowserView({ inDocker, magnitudeEnabled, headless });

    return res.status(200).json({
      // `available` stays config-intent (headed mode requested); `vncRunning`
      // reports whether the stream is actually serviceable right now.
      available: view.available,
      enabled: magnitudeEnabled,
      headless,
      display: view.display,
      novncPort: String(view.novncPort),
      // Where that stream lives. Empty means "derive it from the backend's own
      // origin", which is what the local stack does.
      novncUrl: view.novncUrl,
      password: view.password,
      vncRunning: view.running,
      rfbUp: view.rfbUp,
      novncUp: view.novncUp,
      workHost: view.workHost,
      browserRunning: view.browserRunning,
      note: view.note,
      mode: inDocker ? "docker" : "dev",
    });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .json({ message: "Failed to get Browser Agent VNC config" });
  }
};
