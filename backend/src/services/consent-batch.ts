import SessionsModel, { PendingConsentDoc } from "../models/Sessions/Sessions.model";
import { parseToolArguments } from "../utils/toolArguments";
import type { ToolCallData } from "../utils/llm/types";
import type { SafetyKind } from "../tools/types";
import type { ToolExecutionResult } from "./agent.tools";

// ─── Consent batch ───────────────────────────────────────────────────────
// One owner for the pending-consent record: its shape, the batch-vs-single
// rule, the SSE payload built from it, and its persistence. Before this seam
// the field list was assembled three times (SSE event, Mongo $set, resume
// unpack) and the arguments were re-derived with parseToolArguments at the
// persistence site even though the batch had already computed them.

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
    .filter((result): result is Extract<ToolExecutionResult, { kind: "consent_required" }> => result.kind === "consent_required")
    .map((result) => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      arguments: parseToolArguments(callsById.get(result.toolCallId)?.arguments ?? "{}").args,
      safetyBlock: result.safetyBlock,
      approvalReason: result.approvalReason,
      safetyReason: result.safetyReason,
      safetyImpact: result.safetyImpact,
      safetyKind: result.safetyKind,
    }));
}

/** The `consent_required` SSE payload for a parked batch. */
export function consentRequiredEvent(batch: PendingConsentBatchItem[]) {
  const first = batch[0];
  return {
    id: first.toolCallId,
    name: first.toolName,
    args: first.arguments,
    safetyBlock: first.safetyBlock,
    approvalReason: first.approvalReason,
    safetyReason: first.safetyReason,
    safetyImpact: first.safetyImpact,
    safetyKind: first.safetyKind,
    batch: batch.length > 1 ? batch : undefined,
  };
}

/**
 * Park the batch on the session document: agent state, the pending-consent
 * record, and the consent counters in one write. The batch-vs-single rule
 * (a lone call persists flat, several persist the `batch` array) lives here.
 */
export async function persistPendingConsent(
  sessionId: string,
  batch: PendingConsentBatchItem[],
): Promise<void> {
  const first = batch[0];
  await SessionsModel.updateOne(
    { sessionId },
    {
      $set: {
        agentState: "waiting_consent",
        pendingConsent: {
          toolCallId: first.toolCallId,
          toolName: first.toolName,
          arguments: first.arguments,
          safetyBlock: first.safetyBlock,
          approvalReason: first.approvalReason,
          safetyReason: first.safetyReason,
          safetyImpact: first.safetyImpact,
          safetyKind: first.safetyKind,
          batch: batch.length > 1 ? batch : undefined,
        },
      },
      $inc: {
        "consentStats.prompts": 1,
        "consentStats.safetyBlocks": first.safetyBlock ? 1 : 0,
      },
    },
  );
}

export interface PendingConsentItem {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
}

/**
 * Unpack the pending-consent record into the calls to execute on approval —
 * the mirror image of the batch-vs-single rule in persistPendingConsent.
 */
export function loadPendingConsent(
  pending: PendingConsentDoc | null | undefined,
): PendingConsentItem[] {
  if (!pending) return [];
  return pending.batch && pending.batch.length > 1
    ? pending.batch
    : [{ toolCallId: pending.toolCallId, toolName: pending.toolName, arguments: pending.arguments }];
}

/**
 * The consent counters' one home — the run loop and the consent resume never
 * $inc them by hand: `approvals`/`denials` feed from the user's response,
 * `circuitOpens` from the approval-rejection streak tripping.
 */
export async function recordConsentOutcome(
  sessionId: string,
  approved: boolean,
): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    {
      $inc: {
        "consentStats.approvals": approved ? 1 : 0,
        "consentStats.denials": approved ? 0 : 1,
      },
    },
  );
}

export async function recordCircuitOpen(sessionId: string): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    { $inc: { "consentStats.circuitOpens": 1 } },
  );
}
