import { toolRegistry } from "../tools/registry";
import { ToolDefinition, ExecutionContext, ToolResult, SafetyKind } from "../tools/types";
import { ToolCallData } from "../utils/llm/types";
import { ShellManager, ShellPurpose } from "./shell.manager";
import { EngagementState } from "./engagement-state";
import { stripAnsi, collapseBlankLines } from "../utils/ansi";
import { parseToolArguments } from "../utils/toolArguments";
import { elideMiddle } from "../utils/transcript";
import type { ToolExecutionMode } from "../models/User/User.model";
import {
  decideToolConsent,
  ToolApprovalContext,
  ToolSafetyEvaluator,
} from "./tool-approval.service";

// The model only ever sees this much of a tool result. Too small and it has to
// re-run scans to read their own output; too large and every turn pays for it.
// 12k chars ≈ 3.4k tokens: scan verdicts and errors live in the tail, which
// truncateOutput keeps, so the interesting part always survives.
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000; // 1 min hard cap if no timeoutMs on the definition

/**
 * The proof-of-concept boundary policy, in one place. Both the consent-decision
 * path and the consented-execution defence-in-depth path show this exact text.
 */
function pocBoundaryOutput(reason: string): string {
  return (
    "Blocked at the proof-of-concept boundary: " + reason +
    "\nVulnPen is a security tester, not a system destroyer: a destructive action against the engagement target is never executed and can never be approved. " +
    "Prove the weakness without carrying it out - access what you should not be able to access, act on a test object you own, or show the endpoint is reachable - then record the finding and state that the destructive step was deliberately not performed. " +
    "Note that this only gates altering or deleting data that already exists: creating and using your own resources on the target (registering your own account, filling your own basket, placing your own orders) is normal testing and is allowed."
  );
}

async function executeWithTimeout(
  toolDef: ToolDefinition,
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

/**
 * The outcome of one tool call, as a discriminated union. The valid outcomes
 * (parked for consent, blocked at the boundary, denied by review, executed)
 * are branches of `kind` — not loosely-correlated optional flags the caller
 * has to re-interpret. Every branch except `consent_required` carries a
 * `result` that belongs in the transcript.
 */
export type ToolExecutionResult =
  | ConsentRequiredOutcome
  | BoundaryBlockedOutcome
  | ApprovalDeniedOutcome
  | ExecutedOutcome;

interface ConsentRequiredOutcome {
  kind: "consent_required";
  toolCallId: string;
  toolName: string;
  approvalReason?: string;
  safetyBlock: boolean;
  /** Thai reason/impact shown in the consent dialog. */
  safetyReason?: string;
  safetyImpact?: string;
  safetyKind?: SafetyKind;
}

interface BoundaryBlockedOutcome {
  kind: "boundary_blocked";
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  approvalReason: string;
  safetyKind?: SafetyKind;
}

interface ApprovalDeniedOutcome {
  kind: "approval_denied";
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  approvalReason: string;
}

interface ExecutedOutcome {
  kind: "executed";
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  /**
   * Set only when the AI reviewer passed the call. Unset (or false, on a
   * boundary block) means "not an approval outcome", so the approval circuit
   * breaker ignores the call.
   */
  approvalReviewed?: boolean;
}

export type ToolOutcomeWithResult = Exclude<ToolExecutionResult, { kind: "consent_required" }>;

export function hasTranscriptResult(
  tr: ToolExecutionResult,
): tr is ToolOutcomeWithResult {
  return tr.kind !== "consent_required";
}

function truncateOutput(output: string): string {
  const cleaned = collapseBlankLines(stripAnsi(output));
  // Weight the tail: scan results, summaries and errors live at the end.
  return elideMiddle(
    cleaned,
    MAX_OUTPUT_CHARS,
    `\n\n... [truncated ${cleaned.length - MAX_OUTPUT_CHARS} chars - save to a file for the full output] ...\n\n`,
    0.4,
  );
}

export function buildExecutionContext(params: {
  sessionId: string;
  agentId: string;
  shellManager: ShellManager;
  userId?: string;
  onChunk?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  engagementState?: EngagementState;
}): ExecutionContext {
  const {
    sessionId, agentId, shellManager,
    userId, onChunk, abortSignal, engagementState,
  } = params;

  return {
    sessionId,
    userId,
    agentId,
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

/**
 * The one place a tool definition actually runs: start notification, output
 * wiring, timeout, truncation, done/error notification. Both the direct path
 * and the consented path go through here.
 */
async function runToolDefinition(
  toolDef: ToolDefinition,
  toolCallId: string,
  toolName: string,
  args: Record<string, any>,
  callbacks: ToolExecutionCallbacks,
  ctx: ExecutionContext,
): Promise<{ result: ToolResult; failed: boolean }> {
  callbacks.onToolStart(toolCallId, toolName, args);

  try {
    const toolCtx: ExecutionContext = {
      ...ctx,
      onOutput: (chunk) => callbacks.onToolOutput(toolCallId, chunk),
    };

    const result = await executeWithTimeout(toolDef, args, toolCtx);
    result.output = truncateOutput(result.output);

    if (result.installSuggestion && callbacks.onInstallSuggestion) {
      callbacks.onInstallSuggestion(result.installSuggestion);
    }

    callbacks.onToolDone(toolCallId, result);
    return { result, failed: false };
  } catch (err: any) {
    const error = `Tool execution error: ${err.message ?? err}`;
    callbacks.onToolError(toolCallId, error);
    return { result: { output: error, exitCode: 1 }, failed: true };
  }
}

/** The raw checkReady outcome as a refusal string, or undefined when ready. */
async function readinessRefusal(toolDef: ToolDefinition): Promise<string | undefined> {
  if (!toolDef.checkReady) return undefined;
  try {
    return await toolDef.checkReady();
  } catch (err: any) {
    return `Tool '${toolDef.name}' readiness check failed: ${err?.message ?? err}`;
  }
}

/**
 * The run-path half of the readiness seam: a tool whose external dependency is
 * not configured refuses here instead of executing, and — critically — before
 * the consent decision, so an unconfigured tool never collects an approval it
 * could not honour. checkReady and the schema filter share the same source of
 * truth, so a refusal here means the tool should never have been offered.
 *
 * Returns the refusal as a failed ToolResult after emitting start/done, or
 * undefined when the tool is ready. Shared by the direct path and the
 * consented path, which must refuse identically.
 */
async function refuseIfNotReady(
  toolDef: ToolDefinition,
  toolCallId: string,
  toolName: string,
  args: Record<string, any>,
  callbacks: ToolExecutionCallbacks,
): Promise<ToolResult | undefined> {
  const notReady = await readinessRefusal(toolDef);
  if (!notReady) return undefined;
  const result: ToolResult = { output: notReady, exitCode: 1 };
  callbacks.onToolStart(toolCallId, toolName, args);
  callbacks.onToolDone(toolCallId, result);
  return result;
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
      kind: "executed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output: error, exitCode: 1 },
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
      kind: "executed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output: error, exitCode: 1 },
    };
  }

  const notReadyResult = await refuseIfNotReady(toolDef, toolCall.id, toolCall.name, args, callbacks);
  if (notReadyResult) {
    return {
      kind: "executed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: notReadyResult,
    };
  }

  const safetyDetail = !disableSafetyProtections ? toolDef.describeSafety?.(args, ctx) : undefined;
  const safetyTriggered = safetyDetail !== undefined;
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
      kind: "consent_required",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      approvalReason: approval.reason,
      safetyBlock: safetyTriggered,
      safetyReason: safetyDetail?.reason,
      safetyImpact: safetyDetail?.impact,
      safetyKind: safetyDetail?.kind,
    };
  }

  if (approval.denied && approval.source === "boundary") {
    const output = pocBoundaryOutput(approval.reason);
    callbacks.onToolError(toolCall.id, output);
    return {
      kind: "boundary_blocked",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output, exitCode: 126 },
      approvalReason: approval.reason,
      safetyKind: safetyDetail?.kind,
    };
  }

  if (approval.denied) {
    const output =
      `Approve for me denied this approval-boundary request: ${approval.reason}\n` +
      "Do not retry the same action or bypass the review. Use a materially safer approach, or ask the user.";
    callbacks.onToolError(toolCall.id, output);
    return {
      kind: "approval_denied",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { output, exitCode: 126 },
      approvalReason: approval.reason,
    };
  }

  const { result, failed } = await runToolDefinition(toolDef, toolCall.id, toolCall.name, args, callbacks, ctx);
  return {
    kind: "executed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    // An execution error is not an approval outcome: leave it unset so the
    // approval circuit breaker ignores the call.
    approvalReviewed: failed ? undefined : approval.reviewed,
  };
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
  parkedSafetyKind?: SafetyKind,
): Promise<ToolResult> {
  const toolDef = toolRegistry.get(toolName);
  if (!toolDef) {
    return { output: `Unknown tool: ${toolName}`, exitCode: 1 };
  }

  const notReadyResult = await refuseIfNotReady(toolDef, toolCallId, toolName, args, callbacks);
  if (notReadyResult) {
    return notReadyResult;
  }

  // Defence in depth: the boundary verdict must be re-derived on resume,
  // not trusted from the parked record. engagementState and the declared
  // Target can have changed while the batch waited (the check fails open
  // until a Target exists, so a batch parked early carries no verdict), and
  // a resume that only re-checks destructive_target would execute a tool
  // whose fresh verdict is out_of_scope or dangerous.
  const freshVerdict = toolDef.describeSafety?.(args, ctx);
  if (freshVerdict?.kind === "destructive_target") {
    const output = pocBoundaryOutput(freshVerdict.reason);
    callbacks.onToolError(toolCallId, output);
    return { output, exitCode: 126 };
  }
  if (freshVerdict && freshVerdict.kind !== parkedSafetyKind) {
    const output =
      `Not executed: the consent boundary changed while this approval was pending. ` +
      `Fresh verdict: ${freshVerdict.kind} — ${freshVerdict.reason}. ` +
      "Ask the user for a fresh approval rather than relying on the parked one.";
    callbacks.onToolError(toolCallId, output);
    return { output, exitCode: 126 };
  }

  const { result } = await runToolDefinition(toolDef, toolCallId, toolName, args, callbacks, ctx);
  return result;
}
