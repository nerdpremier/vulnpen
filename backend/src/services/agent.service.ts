import SessionsModel, {
  AgentMessageDoc,
  SessionDoc,
} from "../models/Sessions/Sessions.model";
import { invoke_llm_streaming } from "../utils/llm/streaming";
import { resolveOrchestrator } from "../utils/llm/orchestrator";

import { getUnconfiguredToolNames } from "../utils/toolAvailability";
import { toolRegistry } from "../tools/registry";
import { requestedDeferredNames, mergeLoadedTools } from "../tools/deferred";
import {
  executeToolCalls,
  executeConsentedTool,
  buildExecutionContext,
  ToolExecutionCallbacks,
  ToolExecutionResult,
  ToolOutcomeWithResult,
  hasTranscriptResult,
} from "./agent.tools";
import {
  buildPendingConsentBatch,
  consentRequiredEvent,
  persistPendingConsent,
  loadPendingConsent,
  recordConsentOutcome,
  recordCircuitOpen,
  splitConsentBatch,
} from "./consent-batch";
import { ContextBudget } from "./compaction.service";
import { messagesToOpenAI, estimateToolSchemaTokens } from "./context.service";
import { buildVolatileTail, injectVolatileTail } from "../utils/assistant/volatileContext";
import UserModel, { resolveToolExecutionMode } from "../models/User/User.model";
import type { ToolExecutionMode } from "../models/User/User.model";
import { sessionLifecycle } from "./session.lifecycle";
import { wasSessionClearedSince } from "./session.helpers";
import { engagementStateFromSession } from "./engagement-state";
import { getModelContextLimit, getModelMaxOutput } from "../utils/modelMetadata";
import { normalizeMaxAgentIterations } from "../utils/agentConfig";
import {
  ApprovalRejectionTracker,
  compactApprovalTranscript,
  createAiToolSafetyEvaluator,
} from "./tool-approval.service";

// ─── Agent run state (pause flag, persisted run state) ───────────────

import { isPaused, setAgentState, setPaused } from "./agent-state.service";

// ─── Abort controller registry (for immediate pause) ───────────────────

import {
  abortSession,
  hasActiveController,
  releaseAbortController,
  reserveAbortController,
} from "./agent-controller-registry";

// ─── SSE helpers ─────────────────────────────────────────────────────

import {
  forwardStreamDelta,
  type SSEWriter,
  type SseEventMap,
} from "../utils/sse";

// ─── Message persistence ─────────────────────────────────────────────
// The transcript seam: message constructors, append/replace, token
// bookkeeping and the run-state reset invariant all live in
// session-transcript.ts — the loop only orchestrates.

import {
  appendMessages,
  replaceMessages,
  trackTokens,
  assistantMessage,
  toolResultMessage,
  systemNoteMessage,
  createRunBuffer,
  beginTurn,
  RunBuffer,
} from "./session-transcript";

// ─── Attack-box environment probe (user, home, OS, workspace path) ───

import { probeBoxEnv } from "./box-env";

// ─── Session prompt facts (system message, volatile web-app block) ───
// Everything the prompt renders from the session document lives in
// prompt-facts.ts; the loop only asks for the rendered blocks.

import { buildSystemMessage, buildVolatileWebAppForSession } from "./prompt-facts";
import { buildTraceTags } from "../utils/traceTags";

// ─── Build shell status context (injected after summarization) ──────

import { ShellManager } from "./shell.manager";

function buildShellStatusMessage(shellManager: ShellManager, turnIndex: number): AgentMessageDoc | null {
  const shells = shellManager.getShellList();
  const active = shells.filter((s) => s.status === "active");
  if (active.length === 0 && shells.length === 0) return null;

  const lines = shells.map((s) => {
    const status = s.status === "active" ? "ACTIVE" : "CLOSED";
    return `  - ${s.shellId} | label: "${s.label}" | type: ${s.type} | status: ${status} | created by: ${s.createdBy}`;
  });

  const content = `[Shell Status - ${active.length} active, ${shells.length - active.length} closed]\n${lines.join("\n")}\n\nUse these shell_id values with write_to_shell and read_shell. Use run_bash (without shell_id) for new one-off commands.`;

  return systemNoteMessage(`shell_status_${Date.now()}`, content, turnIndex);
}

// ─── Core agent loop ─────────────────────────────────────────────────
// buildTraceTags lives in utils/traceTags.ts (pure, unit-tested).

/**
 * The session load every run entry point shares: on miss, emit the SSE error
 * and end the stream, so no entry point can leave an HTTP stream hanging open.
 */
async function loadRunSession(sessionId: string, sse: SSEWriter): Promise<SessionDoc | null> {
  const session = await SessionsModel.findOne({ sessionId });
  if (!session) {
    sse.write("error", { message: "Session not found" });
    sse.end();
    return null;
  }
  return session;
}

/**
 * The run setup shared by the main loop and the consent-resume path: the
 * shell manager (created or reused) and the main execution context built from
 * the session's engagement state. One owner, so the two paths cannot drift.
 */
async function buildMainRunContext(params: {
  sessionId: string;
  session: SessionDoc;
  userId: string;
  abortSignal?: AbortSignal;
}) {
  const shellManager = await sessionLifecycle.ensureShellManager(params.sessionId);
  const engagementState = engagementStateFromSession(params.session);
  const ctx = buildExecutionContext({
    sessionId: params.sessionId,
    agentId: "main",
    shellManager,
    userId: params.userId,
    abortSignal: params.abortSignal,
    engagementState,
  });
  return { shellManager, engagementState, ctx };
}

/**
 * SSE plumbing shared by every tool-execution site (the main loop and the
 * consent-resume path). `onConsentRequired` differs per site: the main loop
 * batches consent into one event, so it passes a no-op with a comment.
 */
function createSseToolCallbacks(
  sse: SSEWriter,
  onConsentRequired?: ToolExecutionCallbacks["onConsentRequired"],
): ToolExecutionCallbacks {
  return {
    onToolStart(id, name, args) {
      sse.write("tool_start", { id, name, args });
    },
    onToolOutput(id, chunk) {
      sse.write("tool_output", { id, chunk });
    },
    onToolDone(id, result) {
      sse.write("tool_done", { id, exitCode: result.exitCode, output: result.output, outputLength: result.output.length, files: result.files });
    },
    onToolError(id, error) {
      sse.write("tool_error", { id, error });
    },
    onConsentRequired:
      onConsentRequired ??
      ((_id, _name, _args, _safetyBlock, _approvalReason, _safetyDetail) => {}),
    onInstallSuggestion(suggestion) {
      sse.write("install_suggestion", suggestion);
    },
  };
}

function toolResultToMessage(tr: ToolOutcomeWithResult, turnIndex: number): AgentMessageDoc {
  return toolResultMessage(
    {
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: tr.result.output,
      files: tr.result.files,
    },
    turnIndex,
  );
}

function pushToolResultMessages(
  toolResults: ToolExecutionResult[],
  runBuffer: RunBuffer,
  turnIndex: number,
): void {
  for (const tr of toolResults) {
    // Consent-parked calls have no result yet; their transcript messages are
    // written on the consent path (denial or consented execution).
    if (!hasTranscriptResult(tr)) continue;
    runBuffer.add(toolResultToMessage(tr, turnIndex));
  }
}

export async function runAgentLoop(params: {
  sessionId: string;
  userId: string;
  sse: SSEWriter;
  abortSignal?: AbortSignal;
  /** Stamp all messages this run flushes with a transcript channel. */
  channel?: string;
  /**
   * Approval mode for this turn, overriding the user's own setting. An
   * unattended scan passes "auto_approve" so a launched scan finishes without
   * a human; everything else leaves it undefined and follows the user config.
   */
  toolExecutionMode?: ToolExecutionMode;
}): Promise<void> {
  const { sessionId, userId, sse } = params;

  // The tail must not reach a document that was wiped mid-run — a clear (not
  // a pause or stop) is what suppresses flushing. Captured once: anything
  // cleared after this instant invalidates the tail this run accumulates.
  const runStartedAt = Date.now();

  const session = await loadRunSession(sessionId, sse);
  if (!session) return;

  const user = await UserModel.findById(session.uid).lean();
  const toolExecutionMode =
    params.toolExecutionMode ?? resolveToolExecutionMode(user?.configs);
  const disableSafetyProtections = user?.configs?.disableSafetyProtections ?? false;
  const maxAgentIterations = normalizeMaxAgentIterations(
    user?.configs?.maxAgentIterations,
  );
  // Tools disabled at user level (Settings) apply to every session; the
  // session-level list narrows further.
  const disabledAgentTools: string[] = [
    ...new Set([
      ...(user?.configs?.disabledAgentTools ?? []),
      ...(session.disabledAgentTools ?? []),
    ]),
  ];

  await setAgentState(sessionId, "running");
  await setPaused(sessionId, false);

  const { shellManager, engagementState, ctx: executionCtx } = await buildMainRunContext({
    sessionId,
    session,
    userId,
    abortSignal: params.abortSignal,
  });

  // Attack-box facts for the prompt's env section — one probe, owned by
  // box-env.ts. Undefined when the shell is not connected or the probe
  // fails, and the prompt then renders without an env section.
  const envInfo = await probeBoxEnv(shellManager);

  const runBuffer = createRunBuffer(
    sessionId,
    [...session.messages],
    () => !wasSessionClearedSince(sessionId, runStartedAt),
    params.channel,
  );

  // Refresh the system message on every turn so model assignments changed
  // in Settings are immediately visible to the orchestrator. The volatile
  // web-app part (plan render + risk posture) is re-rendered per iteration
  // from the session document below, so plan/finding mutations made by tools
  // mid-run reach the model without invalidating the prompt-cached static
  // prefix.
  if (runBuffer.transcript.length > 0 && runBuffer.transcript[0].role === "system") {
    runBuffer.setSystem(await buildSystemMessage(sessionId, userId, envInfo));
  }

  const turnIndex = session.turnIndex;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let iteration = 0;
  let completedNormally = false;
  const approvalRejections = new ApprovalRejectionTracker();

  // Shared by the proactive path and the finishReason === "length" path. The
  // cached-prompt reset lives inside ContextBudget.compact — that invariant is
  // what once caused the re-summary loop.
  const compactMessages = async (
    summarizingEvent: SseEventMap["summarizing"],
    toolSchemaTokens: number,
    opts: { emitSummaryDone?: boolean } = {},
  ): Promise<void> => {
    sse.write("summarizing", summarizingEvent);
    const { summaryMessage, preservedMessages } = await contextBudget.compact(
      runBuffer.transcript,
      {
        traceContext: { sessionId, userId },
        engagementState,
        toolSchemaTokens,
      },
    );
    runBuffer.replaceTranscript(preservedMessages);
    await replaceMessages(sessionId, runBuffer.transcript);
    if (summaryMessage && opts.emitSummaryDone) {
      sse.write("summary_done", { summary: summaryMessage.content ?? "" });
    }
  };

  // ─── Resolve user model config for the orchestrator ──
  const { config: orchestratorConfig, reasoningMode: orchestratorReasoningMode } =
    await resolveOrchestrator(userId);

  // The loop knows the orchestrator's model here, so it injects the context
  // limit and the output ceiling the endpoint declared instead of letting the
  // budget re-derive them from the provider config on every plan call.
  const contextBudget = new ContextBudget(
    getModelContextLimit(orchestratorConfig.model, orchestratorConfig.contextWindow),
    getModelMaxOutput(orchestratorConfig.model, orchestratorConfig.maxOutputTokens),
  );
  const toolSafetyEvaluator = toolExecutionMode === "auto_approve"
    ? createAiToolSafetyEvaluator({
        provider: orchestratorConfig,
        userId: session.uid.toString(),
        abortSignal: params.abortSignal,
      })
    : undefined;

  try {
    while (iteration < maxAgentIterations) {
      iteration++;

      // Flush whatever the previous iteration produced. Without this, messages
      // only reach the database when the run ends, so the UI shows an empty
      // chat for the whole run (server-started runs have no SSE stream either),
      // and a crash or restart discards every message since turn one.
      //
      // Sits at the top of the loop so it also covers iterations that ended via
      // `continue`; the final iteration is still flushed by the exit paths.
      // flushIfLive skips when the session was cleared mid-run — the only
      // thing that suppresses flushing; pause and stop still persist.
      await runBuffer.flushIfLive();

      if (await isPaused(sessionId)) {
        await setAgentState(sessionId, "paused");
        sse.write("paused", { message: "Agent paused by user" });
        sse.end();
        return;
      }

      if (params.abortSignal?.aborted) {
        break;
      }

      // Compaction is planned EVERY iteration from the current message list.
      // The previous implementation gated on a cached lastPromptTokens that was
      // never reset after a summary, so once the prompt crossed the threshold
      // every single tool-loop iteration re-summarized: compress, run one or
      // two tools, compress again. planCompaction re-estimates from the
      // post-compaction message list and additionally refuses to summarize when
      // too few new messages have accumulated, or when the summary would not
      // free meaningful space (an LLM call spent for nothing).
      // The tool schemas ride along on every call but are not part of the
      // message list; cost them from the schemas actually in play (including
      // deferred tools loaded mid-run) so the budget self-corrects.
      const unconfiguredTools = await getUnconfiguredToolNames();
      const tools = toolRegistry.toOpenAISchemas({
        disabledTools: disabledAgentTools,
        unconfiguredTools,
        loadedTools: session.loadedTools ?? [],
      });
      const toolSchemaTokens = estimateToolSchemaTokens(tools);
      const compaction = await contextBudget.plan(runBuffer.transcript, toolSchemaTokens);
      if (compaction.shouldCompact) {
        await compactMessages(
          {
            message: "Context approaching limit, summarizing...",
            promptTokens: compaction.promptTokens,
            budget: compaction.budget,
            projectedPromptTokens: compaction.projectedPromptTokens,
            reason: compaction.reason,
          },
          toolSchemaTokens,
          { emitSummaryDone: true },
        );

        const shellStatusMsg = buildShellStatusMessage(shellManager, turnIndex);
        if (shellStatusMsg) {
          runBuffer.add(shellStatusMsg);
        }
      }

      // Inject the volatile system tail — current time plus the structured
      // engagement state plus the WSTG plan and risk posture (re-rendered
      // from the session document, so mid-run plan/finding mutations are
      // visible) — after the static prompt. anthropicParams splits requests
      // at the <volatile_system> marker, so this tail can change between
      // turns and tool-loop iterations without invalidating the prompt-cached
      // static prefix (~4.5k tokens) on Anthropic providers.
      if (runBuffer.transcript.length > 0 && runBuffer.transcript[0].role === "system") {
        const stateBlock = engagementState.isEmpty()
          ? ""
          : "\n" + engagementState.toPromptBlock();
        const volatileWebApp = await buildVolatileWebAppForSession(sessionId);
        runBuffer.updateSystem((system) => ({
          ...system,
          content: injectVolatileTail(
            system.content ?? "",
            buildVolatileTail({ timezone: tz, stateBlock, webApp: volatileWebApp }),
          ),
        }));
      }

      const openaiMessages = messagesToOpenAI(runBuffer.transcript, orchestratorConfig.provider === "kimi");

      const { tags: traceTags, phase } = buildTraceTags("agent", runBuffer.transcript, [
        `session_id:${sessionId}`,
        `workspace_id:${session.workspaceId ?? "unknown"}`,
        `agent_role:main_orchestrator`,
      ]);

      const result = await invoke_llm_streaming({
        messages: openaiMessages,
        tools,
        temperature: 0.7,
        reasoningMode: orchestratorReasoningMode,
        providerOverride: orchestratorConfig,
        sessionId,
        userId: session.uid.toString(),
        tags: traceTags,
        generationName: `agent-${phase}-step-${iteration}`,
        abortSignal: params.abortSignal,
        // Pure SSE forwarding — the delta→event translation lives with the
        // catalog in sse.ts. The final text/reasoning come from the invoke
        // result (the stream collector joined the same parts).
        onDelta: (delta) => forwardStreamDelta(sse, delta),
      });

      const assistantToolCalls = result.toolCalls;

      if (result.usage) {
        const promptTokens = result.usage.prompt_tokens ?? 0;
        contextBudget.observe(promptTokens);

        await trackTokens(
          sessionId,
          promptTokens,
          result.usage.completion_tokens ?? 0,
          result.usage.total_tokens ?? 0,
        );

        const contextLimit = getModelContextLimit(
          orchestratorConfig.model,
          orchestratorConfig.contextWindow,
        );
        sse.write("token_usage", {
          totalTokens: promptTokens,
          promptTokens,
          completionTokens: result.usage.completion_tokens ?? 0,
          contextLimit,
          iteration,
          maxIterations: maxAgentIterations,
        });
      }

      const assistantMsg = assistantMessage(
        {
          content: result.content ?? "",
          reasoning: result.reasoning ?? "",
          toolCalls: assistantToolCalls,
        },
        turnIndex,
      );
      runBuffer.add(assistantMsg);

      if (result.finishReason === "length") {
        // The completion was truncated at the token limit, so the cached prompt
        // size is stale-high and would trigger another summary on the very next
        // iteration without the reset inside compactMessages.
        await compactMessages({ message: "Hit token limit, summarizing..." }, toolSchemaTokens);
        continue;
      }

      if (result.finishReason === "stop" || assistantToolCalls.length === 0) {
        completedNormally = true;
        break;
      }

      const callbacks = createSseToolCallbacks(sse, () => {
        // Emitted once as a complete batch below. Streaming individual
        // requests here could briefly hide siblings behind one approval.
      });

      const toolResults = await executeToolCalls(
        sessionId,
        assistantToolCalls,
        callbacks,
        executionCtx,
        disableSafetyProtections,
        toolExecutionMode,
        toolSafetyEvaluator,
        {
          workspacePath: envInfo?.workspacePath,
          engagement: {
            name: session.name,
            description: session.description,
            target: session.engagementContext?.target,
            scope: session.engagementContext?.scope,
          },
          transcript: compactApprovalTranscript(runBuffer.transcript),
        },
      );

      let approvalCircuitOpen = false;
      for (const result of toolResults) {
        // The circuit breaker counts only real approval outcomes: a review
        // denial feeds it a rejection, an AI-reviewed execution an approval.
        // Boundary blocks are not reviews — they are deterministic refusals —
        // and unreviewed executions never enter the streak.
        if (result.kind === "approval_denied") {
          approvalCircuitOpen = approvalRejections.record(true) || approvalCircuitOpen;
        } else if (result.kind === "executed" && result.approvalReviewed === true) {
          approvalCircuitOpen = approvalRejections.record(false) || approvalCircuitOpen;
        }
      }

      const consentResults = toolResults.filter((r) => r.kind === "consent_required");
      if (consentResults.length > 0) {
        pushToolResultMessages(
          toolResults.filter(hasTranscriptResult),
          runBuffer,
          turnIndex,
        );

        // The batch shape, its SSE payload, and its persistence are owned by
        // the consent-batch module; the loop only parks and streams it.
        const batch = buildPendingConsentBatch(consentResults, assistantToolCalls);
        sse.write("consent_required", consentRequiredEvent(batch));
        await runBuffer.flushIfLive();
        await persistPendingConsent(sessionId, batch);
        sse.end();
        return;
      }

      if (approvalCircuitOpen) {
        await recordCircuitOpen(sessionId);
        pushToolResultMessages(toolResults, runBuffer, turnIndex);
        await runBuffer.flushIfLive();
        await setAgentState(sessionId, "idle");
        sse.write("error", {
          message:
            "Approve for me interrupted this turn after repeated denied approval requests.",
        });
        sse.end();
        return;
      }

      pushToolResultMessages(toolResults, runBuffer, turnIndex);

      // The load_tools handler persists to the session document through the
      // same requestedDeferredNames parser applied here, so the in-memory
      // mirror can never admit a name the document would have rejected.
      const newlyLoaded = requestedDeferredNames(assistantToolCalls);
      if (newlyLoaded.length > 0) {
        session.loadedTools = mergeLoadedTools(session.loadedTools, newlyLoaded);
      }

      const askedUser = toolResults.find((r) => r.toolName === "ask_user");
      if (askedUser) {
        completedNormally = true;
        break;
      }
    }

    const reachedIterationLimit =
      iteration >= maxAgentIterations &&
      !completedNormally &&
      !params.abortSignal?.aborted;

    // Unconditional in spirit — but a clear that raced in mid-run must not
    // re-pollute the wiped document with pre-clear messages.
    await runBuffer.flushIfLive();

    if (params.abortSignal?.aborted) {
      await setAgentState(sessionId, "paused");
      sse.write("paused", { message: "Agent paused by user" });
    } else {
      await setAgentState(sessionId, "idle");
      if (reachedIterationLimit) {
        sse.write("iteration_limit", {
          maxIterations: maxAgentIterations,
          message: `The agent used all ${maxAgentIterations} configured turns.`,
        });
      }
      sse.write("done", {
        message: reachedIterationLimit
          ? "Agent paused at the configured turn limit"
          : "Agent turn completed",
        iterations: iteration,
        reachedIterationLimit,
      });
    }
    sse.end();
  } catch (err: any) {
    console.error("[agent] Loop error:", err);
    // flushIfLive skips the flush when the session was cleared mid-run — the
    // document may have just been wiped and must not be re-polluted with
    // stale messages. A pause or stop still flushes.
    await runBuffer.flushIfLive();
    const isAbort = err?.name === "AbortError" || params.abortSignal?.aborted;
    await setAgentState(sessionId, isAbort ? "paused" : "idle");
    if (isAbort) {
      sse.write("paused", { message: "Agent paused by user" });
    } else {
      sse.write("error", { message: err.message ?? "Agent loop error" });
    }
    sse.end();
  }
}

// ─── Initialize a new session and start the agent ────────────────────

export async function initAndRun(params: {
  sessionId: string;
  userId: string;
  userMessage: string;
  sse: SSEWriter;
  abortSignal?: AbortSignal;
  /** Transcript channel for this whole turn (e.g. "run" for UI-launched runs). */
  channel?: string;
  /** Approval mode for this turn; see runAgentLoop. */
  toolExecutionMode?: ToolExecutionMode;
}): Promise<void> {
  const {
    sessionId,
    userId,
    userMessage: userMessageText,
    sse,
    abortSignal,
    channel,
    toolExecutionMode,
  } = params;

  const session = await SessionsModel.findOne({ sessionId });
  if (!session) {
    sse.write("error", { message: "Session not found" });
    sse.end();
    return;
  }

  const userMsg = await beginTurn(session, userMessageText, {
    ensureSystemMessage: () => buildSystemMessage(sessionId, userId),
    channel,
  });

  sse.write("user_message_ack", { id: userMsg.id });

  await runAgentLoop({ sessionId, userId, sse, abortSignal, channel, toolExecutionMode });
}

// ─── Handle consent response and resume ──────────────────────────────

export async function handleConsent(params: {
  sessionId: string;
  userId: string;
  approved: boolean;
  /**
   * Per-item approval: the tool call ids the operator ticked. Omitted means
   * "every item in the batch". An empty array is a denial of everything, never
   * an approval of everything — see the split below.
   */
  approvedToolCallIds?: string[];
  sse: SSEWriter;
  abortSignal?: AbortSignal;
  /** Kept from the run that parked: see initAndRun for both. */
  channel?: string;
  toolExecutionMode?: ToolExecutionMode;
}): Promise<void> {
  const {
    sessionId,
    userId,
    approved,
    approvedToolCallIds,
    sse,
    abortSignal,
    channel,
    toolExecutionMode,
  } = params;

  const session = await loadRunSession(sessionId, sse);
  if (!session) return;
  if (!session.pendingConsent) {
    sse.write("error", { message: "No pending consent" });
    sse.end();
    return;
  }

  // The resume-side unpack of the batch-vs-single rule lives in the
  // consent-batch module, next to the persist side.
  const allPending = loadPendingConsent(session.pendingConsent);

  session.pendingConsent = undefined;
  await session.save();

  /**
   * Split the batch into what may run and what is refused. A supervised scan
   * can park on a mix of actions — a read-only probe and a boundary-crossing
   * one — and the whole point of asking is that the operator may approve one
   * and refuse the other. The rule lives in the consent-batch module, where it
   * is unit-tested, because getting it wrong means running an action nobody
   * approved.
   */
  const { allowed, refused } = splitConsentBatch(
    allPending,
    approved,
    approvedToolCallIds,
  );

  // The approval streak tracks refusals: a mixed response is not a refusal, so
  // it counts as an approval even when some items were denied.
  await recordConsentOutcome(sessionId, allowed.length > 0);

  const denialMessages: AgentMessageDoc[] = refused.map((p) =>
    toolResultMessage(
      {
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        output: "User denied permission to run this tool.",
      },
      session.turnIndex,
    ),
  );

  if (allowed.length === 0) {
    await appendMessages(sessionId, denialMessages);
    await setAgentState(sessionId, "idle");
    await runAgentLoop({ sessionId, userId, sse, abortSignal, channel, toolExecutionMode });
    return;
  }

  const { ctx } = await buildMainRunContext({
    sessionId,
    session,
    userId,
    abortSignal,
  });

  const callbacks = createSseToolCallbacks(sse);

  const toolMessages: AgentMessageDoc[] = [];
  for (const pending of allowed) {
    const result = await executeConsentedTool(
      sessionId,
      pending.toolCallId,
      pending.toolName,
      pending.arguments,
      callbacks,
      ctx,
      pending.safetyKind,
    );
    toolMessages.push(
      toolResultMessage(
        {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          output: result.output,
        },
        session.turnIndex,
      ),
    );
  }

  // Refused items are answered too, or the model waits on a tool result that
  // will never arrive.
  await appendMessages(sessionId, [...toolMessages, ...denialMessages]);
  await runAgentLoop({ sessionId, userId, sse, abortSignal, channel, toolExecutionMode });
}
