import SessionsModel, {
  AgentMessageDoc,
} from "../models/Sessions/Sessions.model";
import {
  invoke_llm_streaming,
  ToolCallData,
  ReasoningMode,
  getUserModels,
  presetToProviderConfig,
  ProviderConfig,
} from "../utils/llm/providers";

import { getUnconfiguredToolNames } from "../utils/toolAvailability";
import { toolRegistry } from "../tools/registry";
import { filterDeferredToolNames } from "../tools/deferred";
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
} from "./consent-batch";
import { ContextBudget, messagesToOpenAI, estimateToolSchemaTokens } from "./context.service";
import { buildSystemPrompt, buildVolatileWebAppPrompt, AgentPromptConfig, BoxEnvInfo } from "../utils/assistant/prompts";
import { buildVolatileTail, injectVolatileTail } from "../utils/assistant/volatileContext";
import { computeOwaspCoverage } from "../knowledge";
import type { SessionVulnerabilityDoc } from "../models/Sessions/Sessions.model";
import UserModel, { resolveToolExecutionMode } from "../models/User/User.model";
import { sessionLifecycle } from "./session.lifecycle";
import { engagementStateFromSession } from "./engagement-state";
import { getModelContextLimit } from "../utils/modelMetadata";
import { parseToolArguments } from "../utils/toolArguments";
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

import type { SSEWriter } from "../utils/sse";

// ─── Message persistence ─────────────────────────────────────────────
// The transcript seam: message constructors, append/replace, token
// bookkeeping and the run-state reset invariant all live in
// session-transcript.ts — the loop only orchestrates.

import {
  appendMessages,
  replaceMessages,
  trackTokens,
  userMessage,
  assistantMessage,
  toolResultMessage,
  systemNoteMessage,
} from "./session-transcript";

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

// ─── Build system message for a session ──────────────────────────────

async function loadSessionPromptFacts(sessionId: string): Promise<{
  engagement: { target: string; scope: string };
  webAppSecurity: NonNullable<AgentPromptConfig["webAppSecurity"]>;
}> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("workspaceId engagementContext webAppTestPlan vulnerabilities")
    .lean();
  const storedVulnerabilities = (session?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
  const owaspCoverage = computeOwaspCoverage(storedVulnerabilities);
  return {
    engagement: {
      target: session?.engagementContext?.target ?? "",
      scope: session?.engagementContext?.scope ?? "",
    },
    webAppSecurity: {
      testPlan: (session?.webAppTestPlan as any) ?? null,
      findingCount: owaspCoverage.total,
      unmappedFindingCount: owaspCoverage.unmapped,
      owaspBreakdown: owaspCoverage.byOwasp.filter((row) => row.findings > 0),
    },
  };
}

async function buildAgentPromptConfig(
  sessionId: string,
  userId: string,
  envInfo?: BoxEnvInfo,
): Promise<AgentPromptConfig> {
  const user = await UserModel.findById(userId);
  const now = new Date();
  const { engagement, webAppSecurity } = await loadSessionPromptFacts(sessionId);
  return {
    sessionId,
    installedCapabilities: user?.configs?.installedCapabilities ?? [],
    selectedCapabilities: user?.configs?.capabilities ?? [],
    currentDate: now.toISOString().split("T")[0],
    currentDay: now.toLocaleDateString("en-US", { weekday: "long" }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    envInfo,
    // Same readiness seam the schema filter uses, so the prompt can never
    // advertise a tool the model is not actually offered.
    unconfiguredToolNames: await getUnconfiguredToolNames(),
    engagement,
    webAppSecurity,
  };
}

/**
 * Re-render the volatile web-app part (WSTG plan + OWASP risk posture) from
 * the session document. Called EVERY tool-loop iteration: update_case and
 * add_vulnerability persist through session-plan-store and the vulnerability
 * tools, so the session snapshot the loop holds in memory goes stale the
 * moment a tool mutates the plan — rendering from the document keeps the
 * model's plan view in step with what the tools report.
 */
async function buildVolatileWebAppForSession(sessionId: string): Promise<string> {
  const { engagement, webAppSecurity } = await loadSessionPromptFacts(sessionId);
  return buildVolatileWebAppPrompt({ sessionId, engagement, webAppSecurity });
}

async function buildSystemMessage(
  sessionId: string,
  userId: string,
  envInfo?: BoxEnvInfo,
): Promise<AgentMessageDoc> {
  const promptConfig = await buildAgentPromptConfig(sessionId, userId, envInfo);
  return systemNoteMessage(`sys_${sessionId}`, buildSystemPrompt(promptConfig), 0);
}

// ─── Build dynamic trace tags from preceding tool results ───────────

export function buildTraceTags(
  prefix: string,
  messages: AgentMessageDoc[],
  extra?: string[],
): { tags: string[]; phase: string } {
  const trailingTools: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" && messages[i].toolName) {
      trailingTools.push(messages[i].toolName!);
    } else {
      break;
    }
  }

  const tags = [prefix];
  if (extra) tags.push(...extra);

  if (trailingTools.length === 0) {
    tags.push("planning");
    return { tags, phase: "plan" };
  }

  tags.push("analyze");
  const uniqueTools = [...new Set(trailingTools)];
  tags.push(...uniqueTools);
  return { tags, phase: "analyze" };
}

// ─── Core agent loop ─────────────────────────────────────────────────

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
  messages: AgentMessageDoc[],
  newMessages: AgentMessageDoc[],
  turnIndex: number,
): void {
  for (const tr of toolResults) {
    // Consent-parked calls have no result yet; their transcript messages are
    // written on the consent path (denial or consented execution).
    if (!hasTranscriptResult(tr)) continue;
    const toolMsg = toolResultToMessage(tr, turnIndex);
    messages.push(toolMsg);
    newMessages.push(toolMsg);
  }
}

export async function runAgentLoop(params: {
  sessionId: string;
  userId: string;
  sse: SSEWriter;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sessionId, userId, sse } = params;

  const session = await SessionsModel.findOne({ sessionId });
  if (!session) {
    sse.write("error", { message: "Session not found" });
    sse.end();
    return;
  }

  const user = await UserModel.findById(session.uid).lean();
  const toolExecutionMode = resolveToolExecutionMode(user?.configs);
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

  const shellManager = await sessionLifecycle.ensureShellManager(sessionId);

  // Detect attack box environment and rebuild system message with real info
  let envInfo: BoxEnvInfo | undefined;
  if (shellManager.isConnected) {
    try {
      const { output: envOut } = await shellManager.execInShell(
        `echo "$USER|||$HOME|||$(uname -s)|||$(uname -m)"`,
        10_000,
      );
      const parts = envOut.trim().split("|||");
      if (parts.length >= 4) {
        const home = parts[1];
        const resolvedWs = shellManager.remoteWorkspaceDir.replace(/^~/, home);
        envInfo = {
          user: parts[0],
          home,
          os: `${parts[2]} (${parts[3]})`,
          workspacePath: resolvedWs,
        };
      }
    } catch (err: any) {
      console.warn(`[agent] Failed to detect box environment: ${err.message}`);
    }
  }

  let messages = [...session.messages];

  // Refresh the system message on every turn so model assignments changed
  // in Settings are immediately visible to the orchestrator. The volatile
  // web-app part (plan render + risk posture) is re-rendered per iteration
  // from the session document below, so plan/finding mutations made by tools
  // mid-run reach the model without invalidating the prompt-cached static
  // prefix.
  if (messages.length > 0 && messages[0].role === "system") {
    messages[0] = await buildSystemMessage(sessionId, userId, envInfo);
  }

  const turnIndex = session.turnIndex;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let iteration = 0;
  const newMessages: AgentMessageDoc[] = [];
  let completedNormally = false;
  const approvalRejections = new ApprovalRejectionTracker();

  // Shared by the proactive path and the finishReason === "length" path. The
  // cached-prompt reset lives inside ContextBudget.compact — that invariant is
  // what once caused the re-summary loop.
  const compactMessages = async (
    summarizingEvent: Record<string, unknown>,
    toolSchemaTokens: number,
    opts: { emitSummaryDone?: boolean } = {},
  ): Promise<void> => {
    sse.write("summarizing", summarizingEvent);
    const { summaryMessage, preservedMessages } = await contextBudget.compact(
      messages,
      {
        traceContext: { sessionId, userId },
        engagementState,
        toolSchemaTokens,
      },
    );
    messages = preservedMessages;
    await replaceMessages(sessionId, messages);
    newMessages.length = 0;
    if (summaryMessage && opts.emitSummaryDone) {
      sse.write("summary_done", { summary: summaryMessage.content });
    }
  };

  // ─── Resolve user model config for the orchestrator ──
  const userModels = await getUserModels(userId);
  const orchestratorConfig: ProviderConfig = await presetToProviderConfig(userModels.orchestrator);
  const orchestratorReasoningMode: ReasoningMode =
    (userModels.orchestrator.reasoningMode as ReasoningMode) || "off";

  // The loop knows the orchestrator's model here, so it injects the context
  // limit instead of letting the budget re-derive it from the provider config
  // on every plan call.
  const contextBudget = new ContextBudget(getModelContextLimit(orchestratorConfig.model));
  const toolSafetyEvaluator = toolExecutionMode === "auto_approve"
    ? createAiToolSafetyEvaluator({
        provider: orchestratorConfig,
        userId: session.uid.toString(),
        abortSignal: params.abortSignal,
      })
    : undefined;

  const engagementState = engagementStateFromSession(session);

  const executionCtx = buildExecutionContext({
    sessionId,
    agentId: "main",
    shellManager,
    userId,
    abortSignal: params.abortSignal,
    engagementState,
  });

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
      // Skipped after abort/clear: clearContext wipes the document and stale
      // pre-clear messages must not be re-appended into the cleared session.
      if (newMessages.length > 0 && !params.abortSignal?.aborted) {
        await appendMessages(sessionId, newMessages);
        newMessages.length = 0;
      }

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
      const compaction = await contextBudget.plan(messages, toolSchemaTokens);
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
          messages.push(shellStatusMsg);
          newMessages.push(shellStatusMsg);
        }
      }

      // Inject the volatile system tail — current time plus the structured
      // engagement state plus the WSTG plan and risk posture (re-rendered
      // from the session document, so mid-run plan/finding mutations are
      // visible) — after the static prompt. anthropicParams splits requests
      // at the <volatile_system> marker, so this tail can change between
      // turns and tool-loop iterations without invalidating the prompt-cached
      // static prefix (~4.5k tokens) on Anthropic providers.
      if (messages.length > 0 && messages[0].role === "system") {
        const stateBlock = engagementState.isEmpty()
          ? ""
          : "\n" + engagementState.toPromptBlock();
        const volatileWebApp = await buildVolatileWebAppForSession(sessionId);
        const sysContent = messages[0].content ?? "";
        messages[0] = {
          ...messages[0],
          content: injectVolatileTail(
            sysContent,
            buildVolatileTail({ timezone: tz, stateBlock, webApp: volatileWebApp }),
          ),
        };
      }

      const openaiMessages = messagesToOpenAI(messages, orchestratorConfig.provider === "kimi");

      let assistantContent = "";
      let assistantReasoning = "";
      let assistantToolCalls: ToolCallData[] = [];

      const { tags: traceTags, phase } = buildTraceTags("agent", messages, [
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
        onDelta(delta) {
          if (delta.type === "reasoning" && delta.content) {
            assistantReasoning += delta.content;
            sse.write("reasoning", { content: delta.content });
          }
          if (delta.type === "text" && delta.content) {
            assistantContent += delta.content;
            sse.write("thinking", { content: delta.content });
          }
          if (delta.type === "tool_call_start" && delta.toolCall) {
            sse.write("tool_call_start", {
              index: delta.toolCall.index,
              id: delta.toolCall.id,
              name: delta.toolCall.name,
            });
          }
          if (delta.type === "tool_call_delta" && delta.content) {
            sse.write("tool_call_args", {
              index: delta.toolCall?.index,
              content: delta.content,
            });
          }
          if (delta.type === "tool_call_done" && delta.toolCall) {
            sse.write("tool_call_ready", {
              index: delta.toolCall.index,
              id: delta.toolCall.id,
              name: delta.toolCall.name,
              arguments: delta.toolCall.arguments,
            });
          }
        },
      });

      assistantToolCalls = result.toolCalls;

      if (result.usage) {
        const promptTokens = result.usage.prompt_tokens ?? 0;
        contextBudget.observe(promptTokens);

        await trackTokens(
          sessionId,
          promptTokens,
          result.usage.completion_tokens ?? 0,
          result.usage.total_tokens ?? 0,
        );

        const contextLimit = getModelContextLimit(orchestratorConfig.model);
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
          content: assistantContent,
          reasoning: assistantReasoning,
          toolCalls: assistantToolCalls,
        },
        turnIndex,
      );
      messages.push(assistantMsg);
      newMessages.push(assistantMsg);

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
          transcript: compactApprovalTranscript(messages),
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
          messages,
          newMessages,
          turnIndex,
        );

        // The batch shape, its SSE payload, and its persistence are owned by
        // the consent-batch module; the loop only parks and streams it.
        const batch = buildPendingConsentBatch(consentResults, assistantToolCalls);
        sse.write("consent_required", consentRequiredEvent(batch));
        await appendMessages(sessionId, newMessages);
        await persistPendingConsent(sessionId, batch);
        sse.end();
        return;
      }

      if (approvalCircuitOpen) {
        await SessionsModel.updateOne(
          { sessionId },
          { $inc: { "consentStats.circuitOpens": 1 } },
        );
        pushToolResultMessages(toolResults, messages, newMessages, turnIndex);
        await appendMessages(sessionId, newMessages);
        newMessages.length = 0;
        await setAgentState(sessionId, "idle");
        sse.write("error", {
          message:
            "Approve for me interrupted this turn after repeated denied approval requests.",
        });
        sse.end();
        return;
      }

      pushToolResultMessages(toolResults, messages, newMessages, turnIndex);

      // The load_tools handler persists to the session document; mirror the
      // change here so the schemas are present from the next iteration on
      // without re-reading the document. filterDeferredToolNames is the same
      // filter the handler applies, so the mirror can never admit a name the
      // document would have rejected.
      for (const tc of assistantToolCalls) {
        if (tc.name !== "load_tools") continue;
        const { valid } = filterDeferredToolNames(parseToolArguments(tc.arguments).args?.tools);
        if (valid.length > 0) {
          session.loadedTools = [...new Set([...(session.loadedTools ?? []), ...valid])];
        }
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

    await appendMessages(sessionId, newMessages);

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
    // Skip the flush on abort/clear — the session document may have just been
    // wiped by clearContext and must not be re-polluted with stale messages.
    if (!params.abortSignal?.aborted) {
      await appendMessages(sessionId, newMessages);
    }
    newMessages.length = 0;
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
}): Promise<void> {
  const { sessionId, userId, userMessage: userMessageText, sse, abortSignal } = params;

  const session = await SessionsModel.findOne({ sessionId });
  if (!session) {
    sse.write("error", { message: "Session not found" });
    sse.end();
    return;
  }

  if (session.messages.length === 0) {
    session.messages.push(await buildSystemMessage(sessionId, userId));
  }

  const userMsg = userMessage(userMessageText, session.turnIndex);
  session.messages.push(userMsg);
  session.turnIndex += 1;
  await session.save();

  sse.write("user_message_ack", { id: userMsg.id });

  await runAgentLoop({ sessionId, userId, sse, abortSignal });
}

// ─── Handle consent response and resume ──────────────────────────────

export async function handleConsent(params: {
  sessionId: string;
  userId: string;
  approved: boolean;
  sse: SSEWriter;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sessionId, userId, approved, sse, abortSignal } = params;

  const session = await SessionsModel.findOne({ sessionId });
  if (!session || !session.pendingConsent) {
    sse.write("error", { message: "No pending consent" });
    sse.end();
    return;
  }

  // The resume-side unpack of the batch-vs-single rule lives in the
  // consent-batch module, next to the persist side.
  const allPending = loadPendingConsent(session.pendingConsent);

  session.pendingConsent = undefined;
  await session.save();
  await SessionsModel.updateOne(
    { sessionId },
    {
      $inc: {
        "consentStats.approvals": approved ? 1 : 0,
        "consentStats.denials": approved ? 0 : 1,
      },
    },
  );

  if (!approved) {
    const denialMessages: AgentMessageDoc[] = allPending.map((p) =>
      toolResultMessage(
        {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          output: "User denied permission to run this tool.",
        },
        session.turnIndex,
      ),
    );
    await appendMessages(sessionId, denialMessages);
    await setAgentState(sessionId, "idle");
    await runAgentLoop({ sessionId, userId, sse, abortSignal });
    return;
  }

  const shellManager = await sessionLifecycle.ensureShellManager(sessionId);

  const ctx = buildExecutionContext({
    sessionId,
    agentId: "main",
    shellManager,
    userId,
    abortSignal,
    engagementState: engagementStateFromSession(session),
  });

  const callbacks = createSseToolCallbacks(sse);

  const toolMessages: AgentMessageDoc[] = [];
  for (const pending of allPending) {
    const result = await executeConsentedTool(
      sessionId,
      pending.toolCallId,
      pending.toolName,
      pending.arguments,
      callbacks,
      ctx,
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

  await appendMessages(sessionId, toolMessages);
  await runAgentLoop({ sessionId, userId, sse, abortSignal });
}
