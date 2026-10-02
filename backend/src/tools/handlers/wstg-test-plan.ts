import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import SessionsModel from "../../models/Sessions/Sessions.model";
import type { WebAppTestPlanDoc } from "../../models/Sessions/Sessions.model";
import {
  TEST_STATUSES,
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
  addTestCase,
  updateTestCase,
  findDuplicateCases,
  removeCases,
} from "../../services/web-security/test-plan.service";
import { WSTG_VERSION, getWstgTest } from "../../knowledge";

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
  const lines = [
    `${testCase.testId} (${testCase.section}) ${testCase.title}`,
    `  status: ${testCase.status} | category: ${testCase.categoryCode || "—"}`,
    `  objective: ${testCase.objective}`,
  ];
  if (verbose) {
    lines.push(`  method: ${testCase.howToTest}`);
    if (testCase.tools.length) lines.push(`  tools: ${testCase.tools.join(", ")}`);
    if (testCase.evidenceExpectation) {
      lines.push(`  expected evidence: ${testCase.evidenceExpectation}`);
    }
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
    'Use action "generate" to build or refresh the plan for a target (full WSTG catalogue by default, ' +
    'optionally narrowed by categories or an explicit list of test ids), "list" to see what is planned, ' +
    '"get" to read one test case in full, "update_case" to record the result of a test or edit its text ' +
    '(status, observations, title, objective, method, notes and linked findings), "add_case" to add a ' +
    'custom case that is not part of the WSTG catalogue (the tool rejects cases that duplicate one ' +
    'already in the plan — read the existing case it names instead of re-testing it), "delete_case" to ' +
    'remove cases you added by mistake, and "coverage" to report progress. ' +
    "The plan is persisted in the session and returned to you in the system prompt, so keep it current: " +
    "mark a case in_progress before you start it, and set it to passed or failed as soon as you know the result.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["generate", "list", "get", "update_case", "add_case", "delete_case", "coverage"],
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
          'Explicit list of WSTG test ids: for "generate" to plan instead of the full catalogue, e.g. ["WSTG-INPV-05"]; for "delete_case" the custom or catalogue cases to drop.',
      },
      test_id: {
        type: "string",
        description:
          'Test id for action "get" or "update_case", e.g. WSTG-INPV-05 or a custom id like CUSTOM-01.',
      },
      title: {
        type: "string",
        description:
          'Title of the case. Required for action "add_case"; optional for "update_case" to rename a case.',
      },
      objective: {
        type: "string",
        description:
          'What the case is trying to establish. Optional for "add_case" and "update_case".',
      },
      how_to_test: {
        type: "string",
        description:
          'How to execute the case: steps, payloads, tooling. Optional for "add_case" and "update_case".',
      },
      category_code: {
        type: "string",
        description:
          'Category for action "add_case": a WSTG category code (e.g. INPV) or free text. Optional.',
      },
      status: {
        type: "string",
        enum: TEST_STATUSES,
        description:
          "Result of the test for action \"update_case\": not_started, in_progress, passed, failed, blocked or skipped.",
      },
      force: {
        type: "boolean",
        description:
          'For action "add_case": set true to add the case even though the plan already holds one that looks ' +
          "like the same test. Only do this when the existing case genuinely tests something different.",
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
          categories: Array.isArray(args.categories) ? args.categories : undefined,
          testIds: Array.isArray(args.test_ids) ? args.test_ids : undefined,
          existing,
        });
        await persistPlan(sessionId, result.plan);

        const next = nextTestsToRun(result.plan, 8);
        const lines = [
          `Test plan ${existing ? "updated" : "created"}: ${result.plan.cases.length} WSTG v${WSTG_VERSION} test cases. ${result.added} added, ${result.kept} kept with their previous status.`,
          result.plan.target ? `Target: ${result.plan.target}` : "",
          result.plan.scope ? `Scope: ${result.plan.scope}` : "",
          coverageLine(result.plan),
          "",
          "Start with these (plan order):",
          ...next.map(
            (testCase) => `- ${testCase.testId} (${testCase.section}) ${testCase.title}`,
          ),
          "",
          'Update each case with action "update_case" as you work through it. Add custom cases with action "add_case".',
        ];
        return { output: lines.filter(Boolean).join("\n"), exitCode: 0 };
      }

      const plan = await loadPlan(sessionId);
      if (!plan) {
        return {
          output:
            'No WSTG test plan exists for this session yet. Call wstg_test_plan with action "generate" (optionally with target, scope and categories) first.',
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
              `- ${row.key} ${row.label}: ${row.executed}/${row.total} (${row.passed} passed, ${row.failed} failed, ${row.blocked} blocked)`,
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

      if (action === "add_case") {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) {
          return { output: '"add_case" requires a title.', exitCode: 1 };
        }
        // Refuse cases the plan already covers: duplicated work inflates
        // coverage numbers without testing anything new.
        const duplicates = findDuplicateCases(plan, {
          title,
          objective: typeof args.objective === "string" ? args.objective : undefined,
          categoryCode: typeof args.category_code === "string" ? args.category_code : undefined,
        });
        if (duplicates.length && args.force !== true) {
          const lines = [
            "Could not add the case: the plan already contains case(s) that appear to test the same thing.",
            "",
            ...duplicates.map(
              (hit) =>
                `- ${hit.testId} ${hit.title} (shared terms: ${hit.sharedTokens.join(", ")})`,
            ),
            "",
            'Read the existing case with action "get" and run it instead of adding a duplicate.',
            "If the existing case genuinely tests something different, call add_case again with force=true.",
          ];
          return { output: lines.join("\n"), exitCode: 1 };
        }
        const added = addTestCase(plan, {
          testId: typeof args.test_id === "string" ? args.test_id : undefined,
          title: args.title,
          objective: args.objective,
          howToTest: typeof args.how_to_test === "string" ? args.how_to_test : args.howToTest,
          categoryCode: args.category_code ?? args.categoryCode,
          notes: args.notes,
        });
        if (!added) {
          return {
            output:
              args.title
                ? "Could not add the case: a case with that test_id already exists."
                : '"add_case" requires a title.',
            exitCode: 1,
          };
        }
        await persistPlan(sessionId, added.plan);
        const lines = [
          `Added case ${added.testCase.testId}: ${added.testCase.title}`,
          added.testCase.objective ? `  objective: ${added.testCase.objective}` : "",
          coverageLine(added.plan),
          "",
          'Work it like any other case: action "update_case" with test_id when you run it.',
        ];
        return { output: lines.filter(Boolean).join("\n"), exitCode: 0 };
      }

      if (action === "delete_case") {
        const ids = (Array.isArray(args.test_ids) ? args.test_ids : [])
          .map((id: any) => String(id).trim())
          .filter(Boolean);
        if (typeof args.test_id === "string" && args.test_id.trim()) ids.push(args.test_id.trim());
        if (!ids.length) {
          return { output: '"delete_case" requires test_ids (or a single test_id).', exitCode: 1 };
        }
        const removed = removeCases(plan, ids);
        if (!removed) {
          return {
            output: `None of [${ids.join(", ")}] are in this plan. Use action "list" to see planned test ids.`,
            exitCode: 1,
          };
        }
        await persistPlan(sessionId, removed.plan);
        return {
          output: [
            `Removed ${removed.removed.length} case(s): ${removed.removed.join(", ")}.`,
            removed.plan.cases.some((testCase) => testCase.linkedVulnerabilityIds?.length)
              ? "Linked findings are unaffected; remove the stale finding itself with update_engagement_state action \"remove_finding\" if it was not real."
              : "",
            coverageLine(removed.plan),
          ].filter(Boolean).join("\n"),
          exitCode: 0,
        };
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
              ? `${known.id} is a valid WSTG test but it is not part of this plan. Regenerate the plan with test_ids (or without a category filter) to include it.`
              : `Unknown test id "${testId}". Use action "list" to see planned test ids, or action "add_case" to add it as a custom case.`,
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
          title: typeof args.title === "string" ? args.title : undefined,
          objective: typeof args.objective === "string" ? args.objective : undefined,
          howToTest:
            typeof args.how_to_test === "string"
              ? args.how_to_test
              : typeof args.howToTest === "string"
                ? args.howToTest
                : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
          observations: typeof args.observations === "string" ? args.observations : undefined,
          addLinkedVulnerabilityId:
            typeof args.vulnerability_id === "string" ? args.vulnerability_id : undefined,
        });
        if (!updated) {
          return {
            output: `${testId} is not in this plan. Use action "list" to see planned test ids, regenerate the plan to include it, or add it with action "add_case".`,
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
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Number(args.limit))) : 25;
        const shown = cases.slice(0, limit);
        const lines = [
          `WSTG v${WSTG_VERSION} plan — ${coverageLine(plan)}`,
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
