import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import SessionsModel from "../../models/Sessions/Sessions.model";
import type { WebAppTestPlanDoc } from "../../models/Sessions/Sessions.model";
import {
  TEST_PLAN_DEPTHS,
  TEST_STATUSES,
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
  updateTestCase,
} from "../../services/web-security/test-plan.service";
import { WSTG_VERSION, getOwaspCategory, getWstgTest } from "../../knowledge";

async function loadPlan(sessionId: string): Promise<WebAppTestPlanDoc | null> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("webAppTestPlan")
    .lean();
  return (session?.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
}

async function persistPlan(sessionId: string, plan: WebAppTestPlanDoc): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    { $set: { webAppTestPlan: plan } },
  );
}

function coverageLine(plan: WebAppTestPlanDoc): string {
  const coverage = computeCoverage(plan.cases);
  return (
    `${coverage.executed}/${coverage.total} executed (${coverage.percentExecuted}%): ` +
    `${coverage.passed} passed, ${coverage.failed} failed, ${coverage.blocked} blocked, ` +
    `${coverage.inProgress} in progress, ${coverage.notStarted} not started, ${coverage.skipped} skipped.`
  );
}

function caseLine(plan: WebAppTestPlanDoc, testId: string, verbose: boolean): string {
  const testCase = plan.cases.find((item) => item.testId === testId)!;
  const owasp = testCase.owasp
    .map((id) => `${id} ${getOwaspCategory(id)?.title ?? ""}`.trim())
    .join(", ");
  const lines = [
    `${testCase.testId} (${testCase.section}) ${testCase.title}`,
    `  status: ${testCase.status} | owasp: ${owasp} | cwe: ${testCase.cwe.join(", ") || "—"}`,
    `  objective: ${testCase.objective}`,
  ];
  if (verbose) {
    lines.push(`  method: ${testCase.howToTest}`);
    lines.push(`  tools: ${testCase.tools.join(", ")}`);
    lines.push(`  expected evidence: ${testCase.evidenceExpectation}`);
    if (testCase.notes) lines.push(`  notes: ${testCase.notes}`);
    if (testCase.observations) lines.push(`  observations: ${testCase.observations}`);
    if (testCase.linkedVulnerabilityIds?.length) {
      lines.push(`  findings: ${testCase.linkedVulnerabilityIds.join(", ")}`);
    }
  }
  return lines.join("\n");
}

const wstgTestPlan: ToolDefinition = {
  name: "wstg_test_plan",
  description:
    `Plan and track OWASP WSTG v${WSTG_VERSION} test cases for this web application engagement. ` +
    'Use action "generate" to build or refresh the plan for a target, "list" to see what is planned, ' +
    '"get" to read one test case in full, "update_case" to record the result of a test ' +
    '(status plus observations and linked findings), and "coverage" to report progress. ' +
    "The plan is persisted in the session and returned to you in the system prompt, so keep it current: " +
    "mark a case in_progress before you start it, and set it to passed or failed as soon as you know the result.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["generate", "list", "get", "update_case", "coverage"],
        description: "What to do with the WSTG test plan.",
      },
      target: {
        type: "string",
        description: "Primary target under test (URL or host). Used when generating a plan.",
      },
      scope: {
        type: "string",
        description:
          "Scope statement for the plan: in-scope hosts, applications, API surface and any exclusions.",
      },
      depth: {
        type: "string",
        enum: TEST_PLAN_DEPTHS.map((depth) => depth.id),
        description:
          "How much of WSTG v4.2 to plan. smoke = highest-yield tests, standard = all categories, deep = standard plus low-yield tests, full = all test cases.",
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional WSTG category codes to restrict the plan to (INFO, CONF, IDNT, ATHN, ATHZ, SESS, INPV, ERRH, CRYP, BUSL, CLNT, APIT).",
      },
      test_ids: {
        type: "array",
        items: { type: "string" },
        description:
          'Optional explicit list of test ids to plan instead of a depth tier, e.g. ["WSTG-INPV-05", "WSTG-ATHZ-04"].',
      },
      test_id: {
        type: "string",
        description: "Test id for action \"get\" or \"update_case\", e.g. WSTG-INPV-05.",
      },
      status: {
        type: "string",
        enum: TEST_STATUSES,
        description:
          "Result of the test for action \"update_case\": not_started, in_progress, passed, failed, blocked or skipped.",
      },
      observations: {
        type: "string",
        description:
          "What the test actually showed: payloads used, responses observed, why it passed or failed. This feeds the report.",
      },
      notes: {
        type: "string",
        description: "Short note for the case, e.g. why it is blocked or what is still missing.",
      },
      vulnerability_id: {
        type: "string",
        description:
          "Existing finding id to link to this test case when the test produced a vulnerability.",
      },
      limit: {
        type: "number",
        description: "Maximum number of test cases to return for action \"list\" (default 25).",
      },
    },
    required: ["action"],
  },
  timeoutMs: 30_000,
  async execute(args: Record<string, any>, ctx: ExecutionContext): Promise<ToolResult> {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    const sessionId = ctx.sessionId;
    if (!sessionId) return { output: "No session in context.", exitCode: 1 };

    try {
      if (action === "generate") {
        const existing = await loadPlan(sessionId);
        const result = createTestPlan({
          target: typeof args.target === "string" ? args.target : undefined,
          scope: typeof args.scope === "string" ? args.scope : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
          depth: args.depth,
          categories: Array.isArray(args.categories) ? args.categories : undefined,
          testIds: Array.isArray(args.test_ids) ? args.test_ids : undefined,
          existing,
        });
        await persistPlan(sessionId, result.plan);

        const next = nextTestsToRun(result.plan, 8);
        const lines = [
          `Test plan ${existing ? "updated" : "created"}: ${result.plan.cases.length} WSTG v${WSTG_VERSION} test cases (depth: ${result.plan.depth}). ${result.added} added, ${result.kept} kept with their previous status.`,
          result.plan.target ? `Target: ${result.plan.target}` : "",
          result.plan.scope ? `Scope: ${result.plan.scope}` : "",
          coverageLine(result.plan),
          "",
          "Start with these (highest yield first):",
          ...next.map(
            (testCase) =>
              `- ${testCase.testId} (${testCase.section}) ${testCase.title} — ${testCase.owasp.join(", ")}`,
          ),
          "",
          'Update each case with action "update_case" as you work through it.',
        ];
        return { output: lines.filter(Boolean).join("\n"), exitCode: 0 };
      }

      const plan = await loadPlan(sessionId);
      if (!plan) {
        return {
          output:
            'No WSTG test plan exists for this session yet. Call wstg_test_plan with action "generate" (optionally with target, scope and depth) first.',
          exitCode: 1,
        };
      }

      if (action === "coverage") {
        const coverage = computeCoverage(plan.cases);
        const lines = [
          `WSTG v${WSTG_VERSION} plan — ${coverageLine(plan)}`,
          "",
          "By category:",
          ...coverage.byCategory.map(
            (row) =>
              `- ${row.key} ${row.executed}/${row.total} (${row.passed} passed, ${row.failed} failed, ${row.blocked} blocked)`,
          ),
          "",
          "By OWASP Top 10:2025:",
          ...coverage.byOwasp.map(
            (row) => `- ${row.key} ${row.label}: ${row.executed}/${row.total}`,
          ),
        ];
        const failures = plan.cases.filter((testCase) => testCase.status === "failed");
        if (failures.length) {
          lines.push("", "Tests that produced findings:");
          for (const testCase of failures) {
            lines.push(
              `- ${testCase.testId} ${testCase.title} — findings: ${testCase.linkedVulnerabilityIds?.join(", ") || "none linked yet"}`,
            );
          }
        }
        const blocked = plan.cases.filter((testCase) => testCase.status === "blocked");
        if (blocked.length) {
          lines.push("", "Blocked:");
          for (const testCase of blocked) {
            lines.push(`- ${testCase.testId} ${testCase.title} — ${testCase.notes || "no reason recorded"}`);
          }
        }
        return { output: lines.join("\n"), exitCode: 0 };
      }

      if (action === "get") {
        const testId = typeof args.test_id === "string" ? args.test_id : "";
        const testCase = plan.cases.find(
          (item) => item.testId === testId || item.testId.toLowerCase() === testId.toLowerCase(),
        );
        if (!testCase) {
          const known = getWstgTest(testId);
          return {
            output: known
              ? `${known.id} is a valid WSTG test but it is not part of this plan (plan depth: ${plan.depth}). Regenerate the plan with a deeper tier or pass test_ids to add it.`
              : `Unknown test id "${testId}". Use action "list" to see planned test ids.`,
            exitCode: 1,
          };
        }
        return { output: caseLine(plan, testCase.testId, true), exitCode: 0 };
      }

      if (action === "update_case") {
        const testId = typeof args.test_id === "string" ? args.test_id : "";
        if (!testId) {
          return { output: '"update_case" requires test_id.', exitCode: 1 };
        }
        const updated = updateTestCase(plan, testId, {
          status: args.status,
          notes: typeof args.notes === "string" ? args.notes : undefined,
          observations: typeof args.observations === "string" ? args.observations : undefined,
          addLinkedVulnerabilityId:
            typeof args.vulnerability_id === "string" ? args.vulnerability_id : undefined,
        });
        if (!updated) {
          return {
            output: `${testId} is not in this plan. Use action "list" to see planned test ids, or regenerate the plan to include it.`,
            exitCode: 1,
          };
        }
        await persistPlan(sessionId, updated.plan);

        const lines = [
          `${updated.testCase.testId} → ${updated.testCase.status}`,
          coverageLine(updated.plan),
        ];
        if (updated.testCase.status === "failed" && !updated.testCase.linkedVulnerabilityIds?.length) {
          lines.push(
            "",
            "This test found something but no finding is linked yet. Record it with update_engagement_state action \"add_vulnerability\" (include wstg_id = " +
              updated.testCase.testId +
              "), then link it here with vulnerability_id so the report can trace the finding back to the test.",
          );
        }
        return { output: lines.join("\n"), exitCode: 0 };
      }

      if (action === "list") {
        const requestedCategories = (Array.isArray(args.categories) ? args.categories : [])
          .map((code: any) => String(code).trim().toUpperCase())
          .filter(Boolean);
        const statusFilter = typeof args.status === "string" ? args.status.trim() : "";
        let cases = plan.cases;
        if (requestedCategories.length) {
          cases = cases.filter((testCase) => requestedCategories.includes(testCase.categoryCode));
        }
        if (statusFilter) {
          cases = cases.filter((testCase) => testCase.status === statusFilter);
        }
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(97, Number(args.limit))) : 25;
        const shown = cases.slice(0, limit);
        const lines = [
          `WSTG v${WSTG_VERSION} plan (depth: ${plan.depth}) — ${coverageLine(plan)}`,
          requestedCategories.length || statusFilter
            ? `Filtered to ${cases.length} case(s)${statusFilter ? ` with status ${statusFilter}` : ""}.`
            : "",
          "",
          ...shown.map((testCase) => caseLine(plan, testCase.testId, false)),
        ];
        if (cases.length > shown.length) {
          lines.push(`...and ${cases.length - shown.length} more. Raise limit or filter by category.`);
        }
        return { output: lines.filter(Boolean).join("\n"), exitCode: 0 };
      }

      return { output: `Unknown action: ${action}`, exitCode: 1 };
    } catch (err: any) {
      return { output: `wstg_test_plan failed: ${err?.message ?? err}`, exitCode: 1 };
    }
  },
};

export default wstgTestPlan;