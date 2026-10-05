import { v4 as uuidv4 } from "uuid";
import { Response } from "express";
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
import {
  executeToolCalls,
  executeConsentedTool,
  buildExecutionContext,
  buildPendingConsentBatch,
  ToolExecutionCallbacks,
  ToolExecutionResult,
} from "./agent.tools";
import { planCompaction, summarizeMessages, messagesToOpenAI, estimateToolSchemaTokens } from "./context.service";
import { buildSystemPrompt, buildVolatileWebAppPrompt, AgentPromptConfig, BoxEnvInfo } from "../utils/assistant/prompts";
import { computeOwaspCoverage } from "../knowledge";
import type { SessionVulnerabilityDoc } from "../models/Sessions/Sessions.model";
import UserModel, { resolveToolExecutionMode } from "../models/User/User.model";
import { sessionLifecycle } from "./session.lifecycle";
import { EngagementState } from "./engagement-state";
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

export interface SSEWriter {
  write: (event: string, data: any) => void;
  end: () => void;
}

export function createSSEWriter(res: Response): SSEWriter {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  return {
    write(event: string, data: any) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // client disconnected
      }
    },
    end() {
      try {
        res.end();
      } catch {
        // already ended
      }
    },
  };
}

/**
 * An SSEWriter with no client attached, for agent runs started by the server
 * rather than by a streaming request. The agent loop
 * already persists messages and state to the session document, so the UI picks
 * the run up from session history — these events simply have nowhere to go.
 *
 * `error` events are logged, since with no client there is otherwise no trace
 * of why a detached run died.
 */
export function createDetachedSSEWriter(label: string): SSEWriter {
  return {
    write(event: string, data: any) {
      if (event === "error") {
        console.error(`[agent:detached:${label}] ${data?.message ?? JSON.stringify(data)}`);
      }
    },
    end() {},
  };
}

// ─── Message persistence ─────────────────────────────────────────────

async function appendMessages(sessionId: string, messages: AgentMessageDoc[]): Promise<void> {
  if (!messages.length) return;
  await SessionsModel.updateOne(
    { sessionId },
    { $push: { messages: { $each: messages } } },
  );
}

async function replaceMessages(sessionId: string, messages: AgentMessageDoc[]): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    { $set: { messages } },
  );
}

async function trackTokens(
  sessionId: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    {
      $inc: { totalTokens },
      $push: {
        tokenHistory: {
          promptTokens,
          completionTokens,
          totalTokens,
          timestamp: new Date(),
        },
      },
    },
  );
}

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

  return {
    id: `shell_status_${Date.now()}`,
    role: "system",
    content,
    timestamp: new Date(),
    turnIndex,
    isSummary: false,
  };
}

// ─── Build system message for a session ──────────────────────────────

async function buildAgentPromptConfig(
  sessionId: string,
  userId: string,
  envInfo?: BoxEnvInfo,
): Promise<AgentPromptConfig> {
  const user = await UserModel.findById(userId);
  const session = await SessionsModel.findOne({ sessionId })
    .select("workspaceId engagementContext webAppTestPlan vulnerabilities")
    .lean();
  const now = new Date();
  const promptConfig: AgentPromptConfig = {
    sessionId,
    installedCapabilities: user?.configs?.installedCapabilities ?? [],
    selectedCapabilities: user?.configs?.capabilities ?? [],
    currentDate: now.toISOString().split("T")[0],
    currentDay: now.toLocaleDateString("en-US", { weekday: "long" }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    envInfo,
    engagement: {
      target: session?.engagementContext?.target ?? "",
      scope: session?.engagementContext?.scope ?? "",
    },
  };

  const storedVulnerabilities = (session?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
  const owaspCoverage = computeOwaspCoverage(storedVulnerabilities);
  promptConfig.webAppSecurity = {
    testPlan: (session?.webAppTestPlan as any) ?? null,
    findingCount: owaspCoverage.total,
    unmappedFindingCount: owaspCoverage.unmapped,
    owaspBreakdown: owaspCoverage.byOwasp.filter((row) => row.findings > 0),
  };

  return promptConfig;
}

async function buildSystemMessage(
  sessionId: string,
  userId: string,
  envInfo?: BoxEnvInfo,
): Promise<{ sysMsg: AgentMessageDoc; volatileWebApp: string }> {
  const promptConfig = await buildAgentPromptConfig(sessionId, userId, envInfo);
  return {
    sysMsg: {
      id: `sys_${sessionId}`,
      role: "system",
      content: buildSystemPrompt(promptConfig),
      timestamp: new Date(),
      turnIndex: 0,
    },
    volatileWebApp: buildVolatileWebAppPrompt(promptConfig),
  };
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

function toolResultToMessage(tr: ToolExecutionResult, turnIndex: number): AgentMessageDoc {
  return {
    id: uuidv4(),
    role: "tool",
    content: tr.result.output,
    toolCallId: tr.toolCallId,
    toolName: tr.toolName,
    files: tr.result.files,
    timestamp: new Date(),
    turnIndex,
  };
}

function pushToolResultMessages(
  toolResults: ToolExecutionResult[],
  messages: AgentMessageDoc[],
  newMessages: AgentMessageDoc[],
  turnIndex: number,
): void {
  for (const tr of toolResults) {
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
  // web-app part (plan render + risk posture) is captured alongside: it
  // changes with plan/finding mutations and is re-injected inside the
  // <volatile_system> tail below instead of the static prompt, keeping the
  // prompt-cached static prefix warm.
  let volatileWebApp = "";
  if (messages.length > 0 && messages[0].role === "system") {
    const { sysMsg, volatileWebApp: webAppPart } = await buildSystemMessage(sessionId, userId, envInfo);
    messages[0] = sysMsg;
    volatileWebApp = webAppPart;
  }

  const turnIndex = session.turnIndex;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let iteration = 0;
  let lastPromptTokens: number | undefined;
  const newMessages: AgentMessageDoc[] = [];
  let completedNormally = false;
  const approvalRejections = new ApprovalRejectionTracker();

  // Shared by the proactive path and the finishReason === "length" path. The
  // cached-prompt reset inside is the invariant that once caused the re-summary
  // loop: keeping the pre-summary number made the next iteration measure a
  // prompt that no longer existed, so it summarized again immediately.
  const compactMessages = async (
    summarizingEvent: Record<string, unknown>,
    toolSchemaTokens: number,
    opts: { emitSummaryDone?: boolean } = {},
  ): Promise<void> => {
    sse.write("summarizing", summarizingEvent);
    const { summaryMessage, preservedMessages, projectedPromptTokens } =
      await summarizeMessages(
        messages,
        { sessionId, userId },
        engagementState,
        toolSchemaTokens,
      );
    messages = preservedMessages;
    // Reset the cached prompt size to the POST-compaction projection.
    lastPromptTokens = projectedPromptTokens;
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
  const toolSafetyEvaluator = toolExecutionMode === "auto_approve"
    ? createAiToolSafetyEvaluator({
        provider: orchestratorConfig,
        userId: session.uid.toString(),
        abortSignal: params.abortSignal,
      })
    : undefined;

  const engagementState = buildEngagementState(session);

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
      const unconfiguredTools = getUnconfiguredToolNames();
      const tools = toolRegistry.toOpenAISchemas({
        disabledTools: disabledAgentTools,
        unconfiguredTools,
        loadedTools: session.loadedTools ?? [],
      });
      const toolSchemaTokens = estimateToolSchemaTokens(tools);
      const compaction = await planCompaction(messages, lastPromptTokens, toolSchemaTokens);
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
      // engagement state — after the static prompt. anthropicParams splits
      // requests at the <volatile_system> marker, so this tail can change
      // between turns and tool-loop iterations without invalidating the
      // prompt-cached static prefix (~4.5k tokens) on Anthropic providers.
      if (messages.length > 0 && messages[0].role === "system") {
        const stateBlock = engagementState.isEmpty()
          ? ""
          : "\n" + engagementState.toPromptBlock();
        const now = new Date();
        const time = now.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const volatileBlock =
          `<volatile_system>\n<run_clock>Current time: ${time} ${tz}</run_clock>${stateBlock}\n${volatileWebApp}\n</volatile_system>`;
        const sysContent = messages[0].content ?? "";
        const markerStart = sysContent.indexOf("<volatile_system>");
        messages[0] = {
          ...messages[0],
          content:
            markerStart !== -1
              ? sysContent.slice(0, markerStart) + volatileBlock
              : sysContent + "\n\n" + volatileBlock,
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
        lastPromptTokens = result.usage.prompt_tokens ?? 0;

        await trackTokens(
          sessionId,
          lastPromptTokens,
          result.usage.completion_tokens ?? 0,
          result.usage.total_tokens ?? 0,
        );

        const contextLimit = getModelContextLimit(orchestratorConfig.model);
        sse.write("token_usage", {
          totalTokens: lastPromptTokens,
          promptTokens: lastPromptTokens,
          completionTokens: result.usage.completion_tokens ?? 0,
          contextLimit,
          iteration,
          maxIterations: maxAgentIterations,
        });
      }

      const assistantMsg: AgentMessageDoc = {
        id: uuidv4(),
        role: "assistant",
        content: assistantContent || null,
        reasoning: assistantReasoning || undefined,
        toolCalls: assistantToolCalls.length ? assistantToolCalls : undefined,
        timestamp: new Date(),
        turnIndex,
      };
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
        if (!result.approvalReviewed) continue;
        approvalCircuitOpen =
          approvalRejections.record(result.approvalDenied === true) ||
          approvalCircuitOpen;
      }

      const consentResults = toolResults.filter((r) => r.needsConsent);
      if (consentResults.length > 0) {
        pushToolResultMessages(
          toolResults.filter((tr) => !tr.needsConsent),
          messages,
          newMessages,
          turnIndex,
        );

        const firstConsent = consentResults[0];
        const batch = buildPendingConsentBatch(consentResults, assistantToolCalls);
        const firstBatchItem = batch[0];

        sse.write("consent_required", {
          id: firstBatchItem.toolCallId,
          name: firstBatchItem.toolName,
          args: firstBatchItem.arguments,
          safetyBlock: firstBatchItem.safetyBlock,
          approvalReason: firstBatchItem.approvalReason,
          safetyReason: firstBatchItem.safetyReason,
          safetyImpact: firstBatchItem.safetyImpact,
          safetyKind: firstBatchItem.safetyKind,
          batch: batch.length > 1 ? batch : undefined,
        });

        await appendMessages(sessionId, newMessages);
        await SessionsModel.updateOne(
          { sessionId },
          {
            $set: {
              agentState: "waiting_consent",
              pendingConsent: {
                toolCallId: firstConsent.toolCallId,
                toolName: firstConsent.toolName,
                arguments: parseToolArguments(
                  assistantToolCalls.find((tc) => tc.id === firstConsent.toolCallId)?.arguments ?? "{}",
                ).args,
                safetyBlock: firstBatchItem.safetyBlock,
                approvalReason: firstBatchItem.approvalReason,
                safetyReason: firstBatchItem.safetyReason,
                safetyImpact: firstBatchItem.safetyImpact,
                safetyKind: firstBatchItem.safetyKind,
                batch: batch.length > 1 ? batch : undefined,
              },
            },
            $inc: {
              "consentStats.prompts": 1,
              "consentStats.safetyBlocks": firstBatchItem.safetyBlock ? 1 : 0,
            },
          },
        );
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
      // without re-reading the document.
      for (const tc of assistantToolCalls) {
        if (tc.name !== "load_tools") continue;
        const requested = parseToolArguments(tc.arguments).args?.tools;
        if (Array.isArray(requested)) {
          session.loadedTools = [
            ...new Set([...(session.loadedTools ?? []), ...requested.filter((t: unknown) => typeof t === "string")]),
          ];
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
  const { sessionId, userId, userMessage, sse, abortSignal } = params;

  const session = await SessionsModel.findOne({ sessionId });
  if (!session) {
    sse.write("error", { message: "Session not found" });
    sse.end();
    return;
  }

  if (session.messages.length === 0) {
    const { sysMsg } = await buildSystemMessage(sessionId, userId);
    session.messages.push(sysMsg);
  }

  const userMsg: AgentMessageDoc = {
    id: uuidv4(),
    role: "user",
    content: userMessage,
    timestamp: new Date(),
    turnIndex: session.turnIndex,
  };
  session.messages.push(userMsg);
  session.turnIndex += 1;
  await session.save();

  sse.write("user_message_ack", { id: userMsg.id });

  await runAgentLoop({ sessionId, userId, sse, abortSignal });
}

// ─── Engagement state bootstrap ──────────────────────────────────────

/**
 * Rebuild the in-memory engagement state from the persisted session document.
 * Shared by the main agent loop and the consent path so every
 * execution context can record state via update_engagement_state.
 */
export function buildEngagementState(session: any): EngagementState {
  const engagementState = new EngagementState("pentest");
  // Declared engagement boundary. Only the Target arms the scope gate; the free
  // text below is what the gate then parses into the host allowlist, so a stray
  // domain in the Scope prose widens the boundary instead of redefining it.
  engagementState.declaredTarget = session?.engagementContext?.target ?? "";
  engagementState.scope = [
    session?.engagementContext?.target,
    session?.engagementContext?.scope,
  ]
    .filter(Boolean)
    .join(" ");
  engagementState.vulnerabilities = (session?.vulnerabilities ?? []).map((vulnerability: any) => ({
    vulnerabilityId: vulnerability.vulnerabilityId,
    fingerprint: vulnerability.fingerprint,
    host: vulnerability.host,
    service: vulnerability.service,
    endpoint: vulnerability.endpoint,
    title: vulnerability.title,
    severity: vulnerability.severity,
    likelihood: vulnerability.likelihood,
    impactRating: vulnerability.impactRating,
    cwe: vulnerability.cwe,
    evidence: vulnerability.evidence,
    stepsToReproduce: vulnerability.stepsToReproduce,
    contextSummary: vulnerability.contextSummary,
    impact: vulnerability.impact,
    remediation: vulnerability.remediation,
    exploited: vulnerability.exploited,
    cve: vulnerability.cve,
    status: vulnerability.status,
    source: vulnerability.source,
    createdAt: vulnerability.createdAt,
    updatedAt: vulnerability.updatedAt,
  }));
  return engagementState;
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

  const { toolCallId, toolName, arguments: toolArgs, batch } = session.pendingConsent;

  const allPending = batch && batch.length > 1
    ? batch
    : [{ toolCallId, toolName, arguments: toolArgs }];

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
    const denialMessages: AgentMessageDoc[] = allPending.map((p) => ({
      id: uuidv4(),
      role: "tool" as const,
      content: "User denied permission to run this tool.",
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      timestamp: new Date(),
      turnIndex: session.turnIndex,
    }));
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
    engagementState: buildEngagementState(session),
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
    toolMessages.push({
      id: uuidv4(),
      role: "tool",
      content: result.output,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      timestamp: new Date(),
      turnIndex: session.turnIndex,
    });
  }

  await appendMessages(sessionId, toolMessages);
  await runAgentLoop({ sessionId, userId, sse, abortSignal });
}
