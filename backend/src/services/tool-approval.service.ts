/**
 * The approval gate: given how the user asked the agent to behave, does this
 * one tool call run, ask, or get refused?
 *
 * There are two modes (`auto`, `requires_consent`) and one refusal that is not
 * a mode at all — a destructive action against the engagement target is
 * refused outright, whatever the mode, and no reviewer or operator can
 * authorise it. A third mode used to send boundary-crossing actions to an AI
 * reviewer ("Approve for me"); it was removed, and with it every path that
 * could clear a boundary without the operator.
 */

import type { ToolExecutionMode } from "../models/User/User.model";
import type { SafetyDetail, ToolDefinition } from "../tools/types";

export interface ToolApprovalDecision {
  requireConsent: boolean;
  denied: boolean;
  reason: string;
  source: "mode" | "safety" | "boundary";
}

export class ApprovalRejectionTracker {
  private consecutive = 0;
  private recent: boolean[] = [];

  record(denied: boolean): boolean {
    this.consecutive = denied ? this.consecutive + 1 : 0;
    this.recent.push(denied);
    if (this.recent.length > 50) this.recent.shift();
    const recentDenials = this.recent.filter(Boolean).length;
    return this.consecutive >= 3 || recentDenials >= 10;
  }
}

/**
 * The safety verdict that actually reaches the approval gate.
 *
 * The per-user `disableSafetyProtections` setting silences the boundaries an
 * operator finds noisy, but it must not silence the one the product documents
 * as absolute: a destructive action against the engagement target is refused
 * outright and no setting may authorise it. Keeping that decision here means the
 * dispatch cannot re-derive it and drift.
 */
export function effectiveSafetyDetail(
  detail: SafetyDetail | undefined,
  disableSafetyProtections: boolean,
): SafetyDetail | undefined {
  if (!disableSafetyProtections) return detail;
  return detail?.kind === "destructive_target" ? detail : undefined;
}

export function decideToolConsent(params: {
  mode: ToolExecutionMode;
  safetyTriggered: boolean;
  /** Deterministic boundary verdict, if the tool reported one. */
  safetyDetail?: SafetyDetail;
}): ToolApprovalDecision {
  const { mode, safetyTriggered, safetyDetail } = params;

  // A destructive action against the engagement target is refused outright.
  // VulnPen is a security tester, not a system destroyer: no execution mode and
  // no human approval can authorise wiping the client system, so the action
  // never becomes a consent request in the first place.
  if (safetyDetail?.kind === "destructive_target") {
    return {
      requireConsent: false,
      denied: true,
      reason: safetyDetail.reason + " (" + safetyDetail.impact + ")",
      source: "boundary",
    };
  }

  if (mode === "requires_consent") {
    return {
      requireConsent: true,
      denied: false,
      reason: "This mode requires approval for every action.",
      source: "mode",
    };
  }

  // `auto`: the agent works, but an action the deterministic boundary flagged
  // stops for the operator. That is the whole contract — there is no reviewer
  // between the two.
  return safetyTriggered
    ? {
        requireConsent: true,
        denied: false,
        reason: "This action crosses an approval boundary.",
        source: "safety",
      }
    : {
        requireConsent: false,
        denied: false,
        reason: "Automatic execution is enabled.",
        source: "mode",
      };
}
