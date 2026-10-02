import { toolRegistry } from "../tools/registry";
import { ExecutionContext, ToolResult, AgentRole, SafetyKind } from "../tools/types";
import { ToolCallData } from "../utils/llm/providers";
import { ShellManager, ShellPurpose } from "./shell.manager";
import { SSEWriter } from "./agent.service";
import { EngagementState } from "./engagement-state";
import { parseToolArguments } from "../utils/toolArguments";
import type { ToolExecutionMode } from "../models/User/User.model";
import {
  decideToolConsent,
  ToolApprovalContext,
  ToolSafetyEvaluator,
} from "./tool-approval.service";

// ANSI escape sequences necessarily contain a control character.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B\[[0-?]*[-[\]#-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-_]|\r(?!\n)/g;
// The model only ever sees this much of a tool result. Too small and it has to
// re-run scans to read their own output; too large and every turn pays for it.
// 12k chars ≈ 3.4k tokens: scan verdicts and errors live in the tail, which
// truncateOutput keeps, so the interesting part always survives.
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000; // 1 min hard cap if no timeoutMs on the definition

async function executeWithTimeout(
  toolDef: import("../tools/types").ToolDefinition,
  args: Record<string, any>,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const timeoutMs = toolDef.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      toolDef.execute(args, ctx),
      new Promise<ToolResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tool '${toolDef.name}' timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ToolExecutionCallbacks {
  onToolStart: (toolCallId: string, toolName: string, args: Record<string, any>) => void;
  onToolOutput: (toolCallId: string, chunk: string) => void;
  onToolDone: (toolCallId: string, result: ToolResult) => void;
  onToolError: (toolCallId: string, error: string) => void;
  onConsentRequired: (
    toolCallId: string,
    toolName: string,
    args: Record<string, any>,
    safetyBlock?: boolean,
    approvalReason?: string,
    safetyDetail?: { reason: string; impact: string },
  ) => void;
  onInstallSuggestion?: (suggestion: { name: string; label: string; installCommand: string; size: string }) => void;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  needsConsent: boolean;
  approvalReason?: string;
  safetyBlock?: boolean;
  /** Thai reason/impact shown in the consent dialog. */
  safetyReason?: string;
  safetyImpact?: string;
  safetyKind?: SafetyKind;
  approvalReviewed?: boolean;
  approvalDenied?: boolean;
}

export interface PendingConsentBatchItem {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
  safetyBlock: boolean;
  approvalReason?: string;
  safetyReason?: string;
  safetyImpact?: string;
  safetyKind?: SafetyKind;
}

/** Build the exact set presented to the user and later executed on approval. */
export function buildPendingConsentBatch(
  results: ToolExecutionResult[],
  toolCalls: ToolCallData[],
): PendingConsentBatchItem[] {
  const callsById = new Map(toolCalls.map((call) => [call.id, call]));
  return results
    .filter((result) => result.needsConsent)
    .map((result) => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      arguments: parseToolArguments(callsById.get(result.toolCallId)?.arguments ?? "{}").args,
      safetyBlock: result.safetyBlock ?? false,
      approvalReason: result.approvalReason,
      safetyReason: result.safetyReason,
      safetyImpact: result.safetyImpact,
      safetyKind: result.safetyKind,
    }));
}

function truncateOutput(output: string): string {
  let cleaned = output.replace(ANSI_REGEX, "");
  // Progress bars and redraws leave runs of blank/whitespace-only lines that
  // render as stacked stray marks in the chat — collapse them to one.
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= MAX_OUTPUT_CHARS) return cleaned;
  // Weight the tail: scan results, summaries and errors live at the end.
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.4);
  const tail = MAX_OUTPUT_CHARS - head;
  return (
    cleaned.slice(0, head) +
    `\n\n... [truncated ${cleaned.length - MAX_OUTPUT_CHARS} chars - save to a file for the full output] ...\n\n` +
    cleaned.slice(-tail)
  );
}

export function buildExecutionContext(params: {
  sessionId: string;
  agentId: string;
  agentRole?: AgentRole;
  shellManager: ShellManager;
  sse?: SSEWriter;
  userId?: string;
  onChunk?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  engagementState?: EngagementState;
}): ExecutionContext {
  const {
    sessionId, agentId, shellManager,
    sse, userId, onChunk, abortSignal, engagementState,
  } = params;
  const agentRole = params.agentRole ?? "main";

  return {
    sessionId,
    userId,
    agentId,
    agentRole,
    runCommand: (command: string, timeoutMs?: number) =>
      shellManager.execInShell(command, timeoutMs, onChunk, abortSignal),
    spawnShell: (label: string, type?: "pty" | "exec", purpose?: ShellPurpose) =>
      shellManager.spawnShell({ label, type, purpose, createdBy: "agent" }),
    writeToShell: (shellId: string, data: string) =>
      shellManager.writeToShell(shellId, data),
    readShellOutput: (shellId: string, fromOffset?: number) =>
      Promise.resolve(shellManager.readOutput(shellId, fromOffset)),
    closeShell: (shellId: string) =>
      shellManager.closeShell(shellId),
    resizeShell: (shellId: string, cols: number, rows: number) =>
      shellManager.resizeShell(shellId, cols, rows),
    listShells: () =>
      shellManager.getShellList(),
    getShellInfo: (shellId: string) =>
      shellManager.getShell(shellId),
    onOutput: onChunk,
    engagementState,
  };
}

export async function executeToolCall(
  sessionId: string,
  toolCall: ToolCallData,
  callbacks: ToolExecutionCallbacks,
  ctx: ExecutionContext,
  disableSafetyProtections?: boolean,
  toolExecutionMode?: ToolExecutionMode,
  toolSafetyEvaluator?: ToolSafetyEvaluator,
  approvalContext?: ToolApprovalContext,
): Promise<ToolExecutionResult> {
  const toolDef = toolRegistry.get(toolCall.name);

  if (!toolDef) {
    const error = `Unknown tool: ${toolCall.name}`;
    callbacks.onToolError(toolCall.id, error);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output: error, exitCode: 1 },
      needsConsent: false,
    };
  }

  let args: Record<string, any>;
  try {
    const parsed = parseToolArguments(toolCall.arguments);
    args = parsed.args;
    // Keep the repaired form in the assistant trace as well. Otherwise the
    // next model turn would receive the original truncated JSON again.
    if (parsed.repaired) toolCall.arguments = JSON.stringify(args);
  } catch (err: any) {
    const detail = err instanceof Error ? err.message : String(err);
    const error = `Failed to parse tool arguments for '${toolCall.name}': ${detail}`;
    callbacks.onToolError(toolCall.id, error);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output: error, exitCode: 1 },
      needsConsent: false,
    };
  }

  const safetyTriggered = !disableSafetyProtections && (toolDef.shouldRequireConsent?.(args, ctx) ?? false);
  const safetyDetail = safetyTriggered ? toolDef.describeSafety?.(args, ctx) : undefined;
  const mode: ToolExecutionMode = toolExecutionMode ?? "auto";
  const approval = await decideToolConsent({
    mode,
    tool: toolDef,
    args,
    context: ctx,
    safetyTriggered,
    safetyDetail,
    evaluator: toolSafetyEvaluator,
    approvalContext,
  });
  const needsConsent = approval.requireConsent;
  if (needsConsent) {
    callbacks.onConsentRequired(toolCall.id, toolCall.name, args, safetyTriggered, approval.reason, safetyDetail);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output: "", exitCode: 0 },
      needsConsent: true,
      approvalReason: approval.reason,
      safetyBlock: safetyTriggered,
      safetyReason: safetyDetail?.reason,
      safetyImpact: safetyDetail?.impact,
      safetyKind: safetyDetail?.kind,
    };
  }

  if (approval.denied && approval.source === "boundary") {
    const output =
      "Blocked at the proof-of-concept boundary: " + approval.reason +
      "\nVulnPen is a security tester, not a system destroyer: a destructive action against the engagement target is never executed and can never be approved. " +
      "Prove the weakness without carrying it out - access what you should not be able to access, act on a test object you own, or show the endpoint is reachable - then record the finding and state that the destructive step was deliberately not performed. " +
      "Note that this only gates altering or deleting data that already exists: creating and using your own resources on the target (registering your own account, filling your own basket, placing your own orders) is normal testing and is allowed.";
    callbacks.onToolError(toolCall.id, output);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output, exitCode: 126 },
      needsConsent: false,
      approvalReason: approval.reason,
      safetyBlock: true,
      safetyKind: safetyDetail?.kind,
      approvalReviewed: false,
      approvalDenied: true,
    };
  }

  if (approval.denied) {
    const output =
      `Approve for me denied this approval-boundary request: ${approval.reason}\n` +
      "Do not retry the same action or bypass the review. Use a materially safer approach, or ask the user.";
    callbacks.onToolError(toolCall.id, output);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output, exitCode: 126 },
      needsConsent: false,
      approvalReason: approval.reason,
      approvalReviewed: true,
      approvalDenied: true,
    };
  }

  callbacks.onToolStart(toolCall.id, toolCall.name, args);

  try {
    const toolCtx: ExecutionContext = {
      ...ctx,
      onOutput: (chunk) => callbacks.onToolOutput(toolCall.id, chunk),
    };

    const result = await executeWithTimeout(toolDef, args, toolCtx);
    result.output = truncateOutput(result.output);

    if (result.installSuggestion && callbacks.onInstallSuggestion) {
      callbacks.onInstallSuggestion(result.installSuggestion);
    }

    callbacks.onToolDone(toolCall.id, result);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      needsConsent: false,
      approvalReviewed: approval.reviewed,
    };
  } catch (err: any) {
    const error = `Tool execution error: ${err.message ?? err}`;
    callbacks.onToolError(toolCall.id, error);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output: error, exitCode: 1 },
      needsConsent: false,
    };
  }
}

export async function executeToolCalls(
  sessionId: string,
  toolCalls: ToolCallData[],
  callbacks: ToolExecutionCallbacks,
  ctx: ExecutionContext,
  disableSafetyProtections?: boolean,
  toolExecutionMode?: ToolExecutionMode,
  toolSafetyEvaluator?: ToolSafetyEvaluator,
  approvalContext?: ToolApprovalContext,
): Promise<ToolExecutionResult[]> {
  // Run sequentially, not Promise.all: tool calls in one turn share the
  // session's shell manager, and two run_bash/shell tools racing would
  // interleave input on the same SSH shell and corrupt each other's output.
  const results: ToolExecutionResult[] = [];
  for (const tc of toolCalls) {
    results.push(
      await executeToolCall(
        sessionId,
        tc,
        callbacks,
        ctx,
        disableSafetyProtections,
        toolExecutionMode,
        toolSafetyEvaluator,
        approvalContext,
      ),
    );
  }
  return results;
}

export async function executeConsentedTool(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, any>,
  callbacks: ToolExecutionCallbacks,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const toolDef = toolRegistry.get(toolName);
  if (!toolDef) {
    return { output: `Unknown tool: ${toolName}`, exitCode: 1 };
  }

  // Defence in depth: a destructive target action can never be executed, even if
  // a stale pending-consent record somehow tried to carry one here.
  const blockedAtBoundary = toolDef.describeSafety?.(args, ctx);
  if (blockedAtBoundary?.kind === "destructive_target") {
    const output =
      "Blocked at the proof-of-concept boundary: " + blockedAtBoundary.reason +
      "\nVulnPen never carries a destructive action out against the engagement target.";
    callbacks.onToolError(toolCallId, output);
    return { output, exitCode: 126 };
  }

  callbacks.onToolStart(toolCallId, toolName, args);

  try {
    const toolCtx: ExecutionContext = {
      ...ctx,
      onOutput: (chunk) => callbacks.onToolOutput(toolCallId, chunk),
    };

    const result = await executeWithTimeout(toolDef, args, toolCtx);
    result.output = truncateOutput(result.output);

    callbacks.onToolDone(toolCallId, result);
    return result;
  } catch (err: any) {
    const error = `Tool execution error: ${err.message ?? err}`;
    callbacks.onToolError(toolCallId, error);
    return { output: error, exitCode: 1 };
  }
}
