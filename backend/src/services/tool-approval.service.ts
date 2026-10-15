/**
 * The approval gate: given how the user asked the agent to behave, does this
 * one tool call run, ask, or get refused?
 *
 * There are two modes (`auto`, `requires_consent`) and one boundary that
 * applies in *both* — a destructive action against the engagement target, or a
 * request that leaves the declared scope, stops for the operator even in `auto`,
 * where the agent otherwise works unsupervised. The product is proof-of-concept:
 * the agent demonstrates the access and records the payload, and a destructive
 * step is the operator's decision to make, not the agent's to take silently.
 * There is no AI reviewer between the two.
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
 * operator finds noisy. It does not silence the destructive-target verdict:
 * that one is a text rule over a command the agent wrote, so a payload that
 * merely contains the word `delete` reads like the real thing, and what it
 * gates is irreversible on someone else's system. The operator answers those
 * prompts; the setting does not remove them.
 */
/**
 * Operator opt-out applies to noisy heuristic boundaries only (dangerous, out_of_scope).
 * The destructive-target kind is never suppressed: the detector is a text rule over a
 * command the agent wrote, so a payload containing 'delete' reads like the real thing,
 * and what it gates is irreversible on someone else's system. The operator is the only one
 * who can author a destructive call; a toggle cannot delegate that decision.
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

  // A boundary verdict stops the call in *every* mode, `auto` included: the
  // agent works unsupervised otherwise, and these are the two actions whose
  // effect lands on someone else's system. `auto` means "do not ask me about
  // the testing", not "do not ask me about this".
  if (safetyDetail?.kind === "destructive_target") {
    return {
      requireConsent: true,
      denied: false,
      reason: "Destructive action against the engagement target: " + safetyDetail.reason + " (" + safetyDetail.impact + ")",
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
