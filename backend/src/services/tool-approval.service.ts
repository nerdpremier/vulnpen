/**
 * The approval gate: given how the user asked the agent to behave, does this
 * one tool call run or ask?
 *
 * There are three modes, mirroring Claude's permission menu:
 *   - `auto` ("Auto"): tools run; an action the deterministic boundary flags
 *     waits for the operator.
 *   - `requires_consent` ("Manual"): every tool action asks the operator.
 *   - `auto_approve` ("Bypass permissions"): fully autonomous. Every action
 *     runs without asking — the deterministic boundary is recorded but not
 *     enforced as a prompt.
 *
 * Auto and Manual are the human-facing modes, so a destructive action against
 * the engagement target stops for the operator in both. `auto_approve` is the
 * operator's explicit choice to let the agent run the whole engagement on its
 * own, including the irreversible step.
 */

import type { ToolExecutionMode } from "../models/User/User.model";
import type { SafetyDetail } from "../tools/types";

export interface ToolApprovalDecision {
  requireConsent: boolean;
  reason: string;
  source: "mode" | "safety" | "boundary";
}

/**
 * The safety verdict that actually reaches the approval gate.
 *
 * The per-user `disableSafetyProtections` setting silences the boundaries an
 * operator finds noisy (`dangerous`, `out_of_scope`). It does not silence the
 * destructive-target verdict: that one is a text rule over a command the agent
 * wrote, so a payload that merely contains the word `delete` reads like the
 * real thing, and what it gates is irreversible on someone else's system. The
 * verdict therefore always reaches the gate, where the execution mode decides
 * whether it asks the operator or runs.
 */
export function effectiveSafetyDetail(
  detail: SafetyDetail | undefined,
  disableSafetyProtections: boolean,
): SafetyDetail | undefined {
  if (!disableSafetyProtections) return detail;
  if (!detail) return undefined;
  // Keep destructive_target visible even when disableSafetyProtections is on.
  if (detail.kind === "destructive_target") return detail;
  return undefined;
}

export function decideToolConsent(params: {
  mode: ToolExecutionMode;
  safetyTriggered: boolean;
  /** Deterministic boundary verdict, if the tool reported one. */
  safetyDetail?: SafetyDetail;
}): ToolApprovalDecision {
  const { mode, safetyTriggered, safetyDetail } = params;

  // Bypass permissions is the fully autonomous mode: it never parks for an
  // operator. The boundary is still computed (and logged upstream), but it
  // does not become a prompt.
  if (mode === "auto_approve") {
    return {
      requireConsent: false,
      reason: "Bypass permissions runs every action automatically.",
      source: "mode",
    };
  }

  // The two human-facing modes. A destructive action against the engagement
  // target stops for the operator in both: what it gates is irreversible on
  // someone else's system.
  if (safetyDetail?.kind === "destructive_target") {
    return {
      requireConsent: true,
      reason: "Destructive action against the engagement target: " + safetyDetail.reason + " (" + safetyDetail.impact + ")",
      source: "boundary",
    };
  }

  if (mode === "requires_consent") {
    return {
      requireConsent: true,
      reason: "This mode requires approval for every action.",
      source: "mode",
    };
  }

  // `auto`: the agent works, but an action the deterministic boundary flagged
  // stops for the operator.
  return safetyTriggered
    ? {
        requireConsent: true,
        reason: "This action crosses an approval boundary.",
        source: "safety",
      }
    : {
        requireConsent: false,
        reason: "Automatic execution is enabled.",
        source: "mode",
      };
}
