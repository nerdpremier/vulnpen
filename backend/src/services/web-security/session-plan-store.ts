import SessionsModel from "../../models/Sessions/Sessions.model";
import type { WebAppTestPlanDoc } from "../../models/Sessions/Sessions.model";
import { findPlanCase, updateTestCase } from "./test-plan.service";

/**
 * The one place that reads and writes a session's WSTG test plan and keeps the
 * plan ↔ finding invariant: a finding's wstgId, the plan case it is linked to,
 * and the case's failed status never drift apart. The Mongo queries, the
 * write-landed guard, and the refusal texts for broken links live here;
 * callers see plain load/save/link verbs and never touch SessionsModel for
 * plan work.
 */

export async function loadSessionPlan(sessionId: string): Promise<WebAppTestPlanDoc | null> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("webAppTestPlan")
    .lean();
  return (session?.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
}

/**
 * Persist the plan and fail loudly when Mongo does not store it: a write that
 * silently does nothing looks like success in the UI and to the agent, which
 * is worse than an error. Every plan mutation helper in test-plan.service
 * stamps updatedAt, so a matched-but-unchanged write means the session or the
 * write itself is broken.
 */
export async function saveSessionPlan(
  sessionId: string,
  plan: WebAppTestPlanDoc,
  opts?: { uid?: unknown },
): Promise<void> {
  const filter = opts?.uid !== undefined ? { sessionId, uid: opts.uid } : { sessionId };
  const result = await SessionsModel.updateOne(filter, { $set: { webAppTestPlan: plan } });
  if (!result.modifiedCount) {
    throw new Error(
      result.matchedCount
        ? "MongoDB stored no change for the WSTG test plan"
        : "Session not found while saving the WSTG test plan",
    );
  }
}

export type PlanCaseResolution =
  | { ok: true; testId: string }
  | { ok: false; refusal: string };

/**
 * A finding tagged with a WSTG id must point at a real plan case: the report
 * traces every finding back through it, and a made-up or mistyped id silently
 * breaks that chain. Returns the canonical case id, or the refusal for the
 * caller to hand back verbatim.
 */
export async function resolvePlanCase(
  sessionId: string,
  wstgId: string,
): Promise<PlanCaseResolution> {
  const id = wstgId.trim().toUpperCase();
  const plan = await loadSessionPlan(sessionId);
  if (!plan?.cases?.length) {
    return {
      ok: false,
      refusal:
        `data.wstgId "${id}" cannot be verified — this session has no test plan. Re-record ` +
        "without data.wstgId, or generate the plan first (wstg_test_plan action \"generate\").",
    };
  }
  const planCase = findPlanCase(plan, id);
  if (!planCase) {
    const near = plan.cases
      .map((testCase) => testCase.testId)
      .filter((testId) => testId.split("-")[1] === id.split("-")[1])
      .slice(0, 8);
    return {
      ok: false,
      refusal:
        `data.wstgId "${id}" is not a case in this session's test plan` +
        `${near.length ? `. Cases in that category: ${near.join(", ")}` : ""}. ` +
        "Re-record with the exact test id of the case that produced this finding (see the " +
        "plan via wstg_test_plan action \"coverage\"), or omit data.wstgId if no plan case fits.",
    };
  }
  return { ok: true, testId: planCase.testId };
}

/**
 * Recording a finding against a WSTG case IS the failed result for that case:
 * mark it failed and link the finding so wstgId and the plan can never drift
 * apart (the old two-step add_vulnerability → update_case path let them
 * disagree). Returns the linked case id, or undefined when there is no plan to
 * link against.
 */
export async function linkFindingToCase(
  sessionId: string,
  vulnerabilityId: string,
  testId: string,
): Promise<string | undefined> {
  const plan = await loadSessionPlan(sessionId);
  if (!plan?.cases?.length) return undefined;
  const linked = updateTestCase(plan, testId, {
    status: "failed",
    addLinkedVulnerabilityId: vulnerabilityId,
  });
  if (!linked) return undefined;
  await saveSessionPlan(sessionId, linked.plan);
  return linked.testCase.testId;
}

/**
 * Remove a finding's links from every case that references it. Returns
 * whether anything changed, so callers skip the write when nothing pointed at
 * the finding.
 */
export async function unlinkFindingFromCases(
  sessionId: string,
  vulnerabilityId: string,
): Promise<boolean> {
  const plan = await loadSessionPlan(sessionId);
  if (!plan?.cases?.length) return false;
  let unlinked = 0;
  for (const testCase of plan.cases) {
    if (testCase.linkedVulnerabilityIds?.includes(vulnerabilityId)) {
      testCase.linkedVulnerabilityIds = testCase.linkedVulnerabilityIds.filter(
        (id) => id !== vulnerabilityId,
      );
      unlinked += 1;
    }
  }
  if (!unlinked) return false;
  await saveSessionPlan(sessionId, plan);
  return true;
}

/**
 * update_case wants to link an existing finding to a case. Keep the finding's
 * wstgId and the cases it is linked to consistent: the report traces every
 * finding through its wstgId, so a link to a case the finding does not claim
 * (or a wstgId pointing at a case the finding never touched) breaks that
 * chain. Backfills a missing wstgId; returns the refusal when the link
 * contradicts the finding's recorded case, undefined when acceptable.
 */
export async function alignFindingLink(
  sessionId: string,
  plan: WebAppTestPlanDoc,
  vulnerabilityId: string,
  testId: string,
): Promise<string | undefined> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("vulnerabilities.vulnerabilityId vulnerabilities.wstgId")
    .lean();
  const findings =
    (session?.vulnerabilities as
      | Array<{ vulnerabilityId?: string; wstgId?: string }>
      | undefined
    ) ?? [];
  const finding = findings.find((v) => v?.vulnerabilityId === vulnerabilityId);
  if (!finding) {
    return (
      `Cannot link "${vulnerabilityId}": no finding with that id exists in this session. ` +
      `Record it first with update_engagement_state action "add_vulnerability", then link ` +
      `the id it returns.`
    );
  }

  const caseId = findPlanCase(plan, testId)?.testId;
  const findingWstg = (finding.wstgId ?? "").trim().toUpperCase();
  if (caseId && !findingWstg) {
    await SessionsModel.updateOne(
      { sessionId, "vulnerabilities.vulnerabilityId": vulnerabilityId },
      { $set: { "vulnerabilities.$.wstgId": caseId } },
    );
  } else if (caseId && findingWstg && findingWstg !== caseId.toUpperCase()) {
    const primaryCase = plan.cases.find((c) => c.testId.toUpperCase() === findingWstg);
    if (!primaryCase?.linkedVulnerabilityIds?.includes(vulnerabilityId)) {
      return (
        `Cannot link "${vulnerabilityId}" to ${caseId}: the finding is recorded with ` +
        `wstgId ${findingWstg} and that case is not linked to it. Either link ` +
        `${findingWstg} first (update_case ${findingWstg} with vulnerability_id), or record ` +
        `the finding again with data.wstgId = ${caseId} if this case is where it actually belongs.`
      );
    }
  }
  return undefined;
}
