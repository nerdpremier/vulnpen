import { Response, Request } from "express";
import { getModelContextLimit } from "../utils/modelMetadata";
import { v4 as uuidv4 } from "uuid";
import SessionsModel from "../models/Sessions/Sessions.model";
import HistoryArchiveModel from "../models/HistoryArchive/HistoryArchive.model";
import { requireActiveSession, requireOwnedSession, resetSessionContext, engagementBoundary } from "../services/session.helpers";
import { createSSEWriter } from "../utils/sse";
import {
  initAndRun,
  handleConsent,
  runAgentLoop,
} from "../services/agent.service";
import { setAgentState, setPaused } from "../services/agent-state.service";
import { parkedRunContext, pump } from "../services/web-security/run-queue.service";
import { isRunMarker } from "../services/web-security/scan-results";
import {
  reserveAbortController,
  releaseAbortController,
  abortSession,
  hasActiveController,
} from "../services/agent-controller-registry";
import { parseSlashCommand, executeSlashCommand, SLASH_COMMANDS } from "../services/slash-commands";
import { toolRegistry } from "../tools/registry";
import { getUnconfiguredToolNames } from "../utils/toolAvailability";
import { resolveSessionFile } from "../services/artifacts.service";
import { resolveOrchestrator } from "../utils/llm/orchestrator";
import { sessionLifecycle } from "../services/session.lifecycle";
import type { SSEWriter } from "../utils/sse";
import { CapabilityError, installCapability as installCapabilityOnBox } from "../services/capabilities.service";
import WorkspaceModel from "../models/Workspace/Workspace.model";

// Every agent run exit path goes through this: release the controller slot and
// arm the idle timer so ShellManagers (SSH connections, local shells) are torn
// down after 30 idle minutes instead of leaking until process restart. A freed
// slot is also the queue's cue: any UI-launched WSTG run waiting in line starts
// here, whether the slot was held by chat, resume, consent or another run.
function releaseAfterRun(sessionId: string, abortCtrl: AbortController): void {
  releaseAbortController(sessionId, abortCtrl);
  if (sessionLifecycle.hasShellManager(sessionId)) {
    sessionLifecycle.scheduleDestroy(sessionId);
  }
  pump(sessionId).catch((err) =>
    console.error(`[agent] run queue pump failed for ${sessionId}:`, err),
  );
}

/**
 * Recovers a session left in "running" with no live process (e.g. a server
 * restart mid-run). Returns false after writing the 409 when a run genuinely
 * is active.
 */
async function resetStuckRunState(
  session: any,
  sessionId: string,
  res: Response
): Promise<boolean> {
  if (session.agentState !== "running") return true;
  if (hasActiveController(sessionId)) {
    res.status(409).json({ message: "Agent is already running" });
    return false;
  }
  console.warn(`[agent] Session ${sessionId} was stuck in "running" state with no active process. Resetting.`);
  await setAgentState(sessionId, "idle");
  return true;
}

/**
 * Owns the concurrency protocol every agent-run entry point shares: reserve
 * an abort controller slot (409 on conflict), open the SSE stream, abort+pause
 * when the client disconnects, and release the slot when the run settles.
 * Entry points only choose which run to start.
 */
async function withAgentRun(
  req: Request,
  res: Response,
  sessionId: string,
  run: (sse: SSEWriter, abortCtrl: AbortController) => Promise<void>
): Promise<Response | undefined> {
  const abortCtrl = reserveAbortController(sessionId);
  if (!abortCtrl) {
    return res.status(409).json({ message: "Agent is already running" });
  }
  const sse = createSSEWriter(res);

  req.on("close", () => {
    abortSession(sessionId);
    setPaused(sessionId, true).catch(() => {});
  });

  try {
    await run(sse, abortCtrl);
  } finally {
    releaseAfterRun(sessionId, abortCtrl);
  }
}

/**
 * Messages the chat page shows: everything except UI-launched WSTG runs. A
 * run is stamped with channel "run"; runs from before that field existed are
 * recognised by their "[WSTG run …]" instruction marker and stay hidden until
 * the next chat message re-opens the transcript.
 */
function withoutRunTranscript(
  messages: Array<{ role: string; content?: string | null; channel?: string }>,
): typeof messages {
  const visible: typeof messages = [];
  let inRun = false;
  for (const message of messages) {
    if (message.role === "user") {
      inRun = isRunMarker(message.content);
      if (!inRun) visible.push(message);
      continue;
    }
    if (message.channel === "run") continue; // stamped run rows
    if (inRun) continue; // legacy run rows: between the marker and the next chat message
    visible.push(message);
  }
  return visible;
}

export const createSession = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { name, description, workspaceId: providedWorkspaceId } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Session name is required" });
    }

    let workspaceId = providedWorkspaceId;

    if (!workspaceId) {
      workspaceId = uuidv4();
      const workspace = new WorkspaceModel({
        uid: userId,
        workspaceId,
        name: name.length > 50 ? name.substring(0, 50) + "..." : name,
        description: description?.substring(0, 500) ?? "",
        type: "general",
        createdAt: new Date(),
      });
      await workspace.save();
    }

    const sessionId = uuidv4();

    const archiveHistory = new HistoryArchiveModel({
      sessionId,
      history: [],
    });
    await archiveHistory.save();

    const session = new SessionsModel({
      uid: userId,
      sessionId,
      workspaceId,
      name: name.length > 50 ? name.substring(0, 50) + "..." : name,
      description: description?.substring(0, 500) ?? "",
      createdAt: new Date(),
    });
    await session.save();

    return res.status(200).json({ sessionId, workspaceId, message: "Session created" });
  } catch (err: any) {
    console.error("[agent] createSession error:", err);
    return res.status(400).json({ message: "Failed to create session" });
  }
};

export const sendMessage = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ message: "sessionId and message are required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (!(await resetStuckRunState(session, sessionId, res))) return;

    return await withAgentRun(req, res, sessionId, (sse, abortCtrl) =>
      initAndRun({
        sessionId,
        userId,
        userMessage: message,
        sse,
        abortSignal: abortCtrl.signal,
      })
    );
  } catch (err: any) {
    console.error("[agent] sendMessage error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ message: err.message ?? "Agent error" });
    }
  }
};

export const pauseAgent = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    abortSession(sessionId);
    await setPaused(sessionId, true);

    return res.status(200).json({ message: "Pause signal sent" });
  } catch (err: any) {
    console.error("[agent] pauseAgent error:", err);
    return res.status(500).json({ message: "Failed to pause agent" });
  }
};

export const resumeAgent = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, message } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (!(await resetStuckRunState(session, sessionId, res))) return;

    return await withAgentRun(req, res, sessionId, async (sse, abortCtrl) => {
      await setPaused(sessionId, false);

      if (message) {
        await initAndRun({ sessionId, userId, userMessage: message, sse, abortSignal: abortCtrl.signal });
      } else {
        await runAgentLoop({ sessionId, userId, sse, abortSignal: abortCtrl.signal });
      }
    });
  } catch (err: any) {
    console.error("[agent] resumeAgent error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ message: err.message ?? "Resume error" });
    }
  }
};

export const respondToConsent = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, approved, toolCallIds } = req.body;

    if (!sessionId || typeof approved !== "boolean") {
      return res.status(400).json({ message: "sessionId and approved (boolean) are required" });
    }

    // Optional per-item approval: the ids the operator ticked. An empty array
    // means "approve none" — it is never read as "approve everything", because
    // that would turn a mis-rendered checkbox list into a full approval.
    if (toolCallIds !== undefined && !Array.isArray(toolCallIds)) {
      return res.status(400).json({ message: "toolCallIds must be an array of tool call ids" });
    }
    const requestedApprovals =
      Array.isArray(toolCallIds) && toolCallIds.length
        ? toolCallIds.filter((id: unknown): id is string => typeof id === "string")
        : undefined;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (session.agentState !== "waiting_consent") {
      return res.status(400).json({ message: "No pending consent request" });
    }

    // A parked scan resumes as the same scan: its own transcript channel and
    // its own approval mode. A chat's consent returns null and nothing changes.
    const parked = await parkedRunContext(sessionId);

    return await withAgentRun(req, res, sessionId, (sse, abortCtrl) =>
      handleConsent({
        sessionId,
        userId,
        approved,
        approvedToolCallIds: approved ? requestedApprovals : undefined,
        sse,
        abortSignal: abortCtrl.signal,
        channel: parked?.channel,
        toolExecutionMode: parked?.toolExecutionMode,
      })
    );
  } catch (err: any) {
    console.error("[agent] respondToConsent error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ message: err.message ?? "Consent error" });
    }
  }
};

export const getHistory = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    let contextLimit = 128_000;
    try {
      // The widget must reflect the model actually driving the loop — the
      // user's assigned orchestrator, not the env default.
      const { config } = await resolveOrchestrator(userId);
      contextLimit = getModelContextLimit(config.model);
    } catch { /* use default */ }

    const latestTokenSnapshot = session.tokenHistory?.[session.tokenHistory.length - 1];
    const contextTokens = latestTokenSnapshot?.promptTokens ?? 0;

    return res.status(200).json({
      // UI-launched WSTG runs write to their own transcript channel; the chat
      // page never shows them — their activity lives on the case page. The
      // marker walk also hides runs created before the channel existed.
      messages: withoutRunTranscript(session.messages ?? []),
      agentState: session.agentState,
      turnIndex: session.turnIndex,
      pendingConsent: session.pendingConsent ?? null,
      shells: session.shells ?? [],
      // totalTokens here powers the context-usage widget; use latest prompt tokens
      // (current window usage), not cumulative lifetime spend.
      totalTokens: contextTokens,
      lifetimeTokens: session.totalTokens ?? 0,
      promptTokens: latestTokenSnapshot?.promptTokens ?? null,
      completionTokens: latestTokenSnapshot?.completionTokens ?? null,
      contextLimit,
      connectionState: session.connectionState ?? { sshConnected: false, hostConnected: false },
    });
  } catch (err: any) {
    console.error("[agent] getHistory error:", err);
    return res.status(500).json({ message: "Failed to get history" });
  }
};

export const getSessionInfo = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    // The session header names the engagement's parent workspace, so the crumb
    // can read "Workspace / <name>" and link back instead of saying "Session".
    const workspace = session.workspaceId
      ? await WorkspaceModel.findOne({ workspaceId: session.workspaceId }).lean()
      : null;

    return res.status(200).json({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      workspaceName: workspace?.name ?? null,
      name: session.name,
      description: session.description,
      agentState: session.agentState,
      createdAt: session.createdAt,
      totalTokens: session.totalTokens,
      messageCount: session.messages.length,
      connectionState: session.connectionState ?? { sshConnected: false },
      // Engagement boundary captured when the session was created. The plan
      // setup screen edits these same values, so both surfaces stay in step.
      engagement: engagementBoundary(session),
    });
  } catch (err: any) {
    console.error("[agent] getSessionInfo error:", err);
    return res.status(500).json({ message: "Failed to get session info" });
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    await SessionsModel.deleteOne({ sessionId, uid: userId });
    await HistoryArchiveModel.deleteMany({ sessionId });

    return res.status(200).json({ message: "Session deleted" });
  } catch (err: any) {
    console.error("[agent] deleteSession error:", err);
    return res.status(400).json({ message: "Failed to delete session" });
  }
};

export const clearContext = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    abortSession(sessionId);

    await resetSessionContext(sessionId);

    return res.status(200).json({ message: "Context cleared" });
  } catch (err: any) {
    console.error("[agent] clearContext error:", err);
    return res.status(400).json({ message: "Failed to clear context" });
  }
};

export const handleSlashCommand = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ message: "sessionId and message are required" });
    }

    const parsed = parseSlashCommand(message);
    if (!parsed) {
      return res.status(400).json({ message: "Not a valid slash command" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const sse = createSSEWriter(res);

    await executeSlashCommand({
      sessionId,
      userId,
      command: parsed.command,
      args: parsed.args,
      sse,
    });
  } catch (err: any) {
    console.error("[agent] handleSlashCommand error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ message: err.message ?? "Slash command error" });
    }
  }
};

export const getSlashCommands = async (_req: Request, res: Response) => {
  return res.status(200).json(SLASH_COMMANDS);
};

export const getSessionAgentToolsConfig = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const disabledTools: string[] = session.disabledAgentTools || [];
    const unconfigured = new Set(await getUnconfiguredToolNames());
    const allTools = toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      enabled: !disabledTools.includes(t.name),
      configured: !unconfigured.has(t.name),
    }));

    return res.status(200).json({ tools: allTools });
  } catch (err: any) {
    console.error("[agent] getSessionAgentToolsConfig error:", err);
    return res.status(400).json({ message: "Failed to get agent tools config" });
  }
};

export const updateSessionAgentToolsConfig = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const { disabledTools } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    if (!Array.isArray(disabledTools)) {
      return res.status(400).json({ message: "disabledTools must be an array" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    session.disabledAgentTools = disabledTools;
    await session.save();

    return res.status(200).json({ message: "Agent tools config updated" });
  } catch (err: any) {
    console.error("[agent] updateSessionAgentToolsConfig error:", err);
    return res.status(400).json({ message: "Failed to update agent tools config" });
  }
};

export const getUserSessions = async (req: Request, res: Response) => {
  try {
    const user = res.locals.user;

    const sessions = await SessionsModel.find({
      uid: user._id,
      status: { $ne: "archived" },
    })
      .select("sessionId workspaceId name description createdAt agentState totalTokens connectionState")
      .sort({ createdAt: -1 });

    return res.status(200).json(sessions);
  } catch (err: any) {
    console.error("[agent] getUserSessions error:", err);
    return res.status(400).json({ message: "Failed to get sessions" });
  }
};

export const installCapability = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, capabilityName } = req.body;

    if (!sessionId || !capabilityName) {
      return res.status(400).json({ message: "sessionId and capabilityName are required" });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const result = await installCapabilityOnBox(sessionId, capabilityName, res.locals.user);
    return res.status(200).json(result);
  } catch (err: any) {
    if (err instanceof CapabilityError) {
      return res.status(400).json({ message: err.message });
    }
    console.error("[agent] installCapability error:", err);
    return res.status(500).json({ message: err.message ?? "Install failed" });
  }
};

// Serves agent-produced artifacts (browser screenshots) by stored filename.
// Path sanitization, the MIME table, and the traversal guard live in the
// artifacts module; this handler only checks session ownership and streams.
export const getSessionFile = async (req: Request, res: Response) => {
  try {
    // verifySess puts the authenticated user on res.locals, not req.user.
    const userId = res.locals?.userId ?? (req as any).user?.uid;
    const { sessionId, filename } = req.params;

    const session = await requireOwnedSession(userId, sessionId, res);
    if (!session) return;

    const resolved = resolveSessionFile(sessionId, filename ?? "");
    if (!resolved.ok) {
      return res.status(resolved.reason === "not-found" ? 404 : 400).json({
        message:
          resolved.reason === "invalid-filename"
            ? "Invalid filename"
            : resolved.reason === "unsupported-type"
              ? "Unsupported file type"
              : "File not found",
      });
    }

    res.setHeader("Content-Type", resolved.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.sendFile(resolved.filePath);
  } catch (err: any) {
    console.error("[agent] getSessionFile error:", err);
    return res.status(500).json({ message: err.message ?? "Failed to read file" });
  }
};
