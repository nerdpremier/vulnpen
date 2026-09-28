/**
 * OWASP WSTG v4.2 test planning for the Web Application Security Testing assistant.
 *
 * A session owns one test plan. The plan is generated from the static WSTG v4.2
 * catalogue (see ../../knowledge) at a chosen depth, then the agent works
 * through it: it marks cases in progress, records observations, links the
 * findings they produced and finally reports what was never tested. The plan is
 * persisted in the session document and re-injected into the system prompt on
 * every turn, so coverage survives context summarisation.
 */

import {
  WSTG_CATEGORIES,
  WSTG_TESTS,
  WSTG_VERSION,
  getOwaspCategory,
  getWstgTest,
  normalizeOwaspTop10Id,
  normalizeWstgId,
} from "../../knowledge";
import type { OwaspTop10Id, TestPlanDepth, WstgTest, WstgTestStatus } from "../../knowledge";
import type {
  SessionTestCaseDoc,
  WebAppTestPlanDoc,
} from "../../models/Sessions/Sessions.model";

export const TEST_PLAN_SOURCE = `OWASP WSTG v${WSTG_VERSION}`;

export const TEST_STATUSES: WstgTestStatus[] = [
  "not_started",
  "in_progress",
  "passed",
  "failed",
  "blocked",
  "skipped",
];

/**
 * Depth tiers are cumulative. They exist because a web application assessment
 * is a budget: the smoke tier is the set of tests that historically find the
 * most impact per hour, and each later tier adds the tests that need more
 * access, more time or a lower tolerance for noise.
 */
const SMOKE_TEST_IDS = [
  "WSTG-INFO-01",
  "WSTG-INFO-03",
  "WSTG-INFO-05",
  "WSTG-INFO-08",
  "WSTG-CONF-01",
  "WSTG-CONF-02",
  "WSTG-CONF-06",
  "WSTG-CONF-07",
  "WSTG-ATHN-02",
  "WSTG-ATHN-04",
  "WSTG-ATHZ-01",
  "WSTG-ATHZ-02",
  "WSTG-ATHZ-04",
  "WSTG-SESS-02",
  "WSTG-SESS-05",
  "WSTG-INPV-01",
  "WSTG-INPV-05",
  "WSTG-INPV-12",
  "WSTG-INPV-17",
  "WSTG-INPV-19",
  "WSTG-CLNT-01",
  "WSTG-CLNT-09",
  "WSTG-ERRH-02",
  "WSTG-APIT-01",
];

const STANDARD_EXTRA_TEST_IDS = [
  "WSTG-INFO-02",
  "WSTG-INFO-09",
  "WSTG-INFO-10",
  "WSTG-CONF-03",
  "WSTG-CONF-04",
  "WSTG-CONF-05",
  "WSTG-CONF-10",
  "WSTG-IDNT-04",
  "WSTG-ATHN-01",
  "WSTG-ATHN-03",
  "WSTG-ATHN-07",
  "WSTG-ATHN-09",
  "WSTG-ATHZ-03",
  "WSTG-SESS-01",
  "WSTG-SESS-03",
  "WSTG-SESS-06",
  "WSTG-SESS-07",
  "WSTG-INPV-02",
  "WSTG-INPV-04",
  "WSTG-INPV-07",
  "WSTG-INPV-11",
  "WSTG-INPV-15",
  "WSTG-INPV-18",
  "WSTG-CRYP-01",
  "WSTG-CRYP-03",
  "WSTG-BUSL-01",
  "WSTG-BUSL-05",
  "WSTG-BUSL-08",
  "WSTG-CLNT-02",
  "WSTG-CLNT-03",
  "WSTG-CLNT-07",
  "WSTG-CLNT-12",
];

const DEEP_EXTRA_TEST_IDS = [
  "WSTG-INFO-04",
  "WSTG-INFO-06",
  "WSTG-INFO-07",
  "WSTG-CONF-08",
  "WSTG-CONF-09",
  "WSTG-CONF-11",
  "WSTG-IDNT-01",
  "WSTG-IDNT-02",
  "WSTG-IDNT-03",
  "WSTG-IDNT-05",
  "WSTG-ATHN-05",
  "WSTG-ATHN-06",
  "WSTG-ATHN-08",
  "WSTG-ATHN-10",
  "WSTG-SESS-04",
  "WSTG-SESS-08",
  "WSTG-SESS-09",
  "WSTG-INPV-03",
  "WSTG-INPV-06",
  "WSTG-INPV-08",
  "WSTG-INPV-13",
  "WSTG-INPV-14",
  "WSTG-INPV-16",
  "WSTG-CRYP-02",
  "WSTG-CRYP-04",
  "WSTG-BUSL-02",
  "WSTG-BUSL-03",
  "WSTG-BUSL-07",
  "WSTG-CLNT-05",
  "WSTG-CLNT-06",
  "WSTG-CLNT-08",
  "WSTG-CLNT-10",
  "WSTG-CLNT-11",
  "WSTG-CLNT-13",
];

const FULL_EXTRA_TEST_IDS = [
  "WSTG-INPV-09",
  "WSTG-INPV-10",
  "WSTG-ERRH-01",
  "WSTG-BUSL-04",
  "WSTG-BUSL-06",
  "WSTG-BUSL-09",
  "WSTG-CLNT-04",
];

const TIER_TEST_IDS: Record<TestPlanDepth, string[]> = {
  smoke: SMOKE_TEST_IDS,
  standard: [...SMOKE_TEST_IDS, ...STANDARD_EXTRA_TEST_IDS],
  deep: [...SMOKE_TEST_IDS, ...STANDARD_EXTRA_TEST_IDS, ...DEEP_EXTRA_TEST_IDS],
  full: [
    ...SMOKE_TEST_IDS,
    ...STANDARD_EXTRA_TEST_IDS,
    ...DEEP_EXTRA_TEST_IDS,
    ...FULL_EXTRA_TEST_IDS,
  ],
};

/** Catalogue order, reordered so the highest-yield tests come first. */
const PLAN_PRIORITY: ReadonlyMap<string, number> = new Map(
  TIER_TEST_IDS.full.map((id, index) => [id, index] as const),
);

export interface TestPlanDepthOption {
  id: TestPlanDepth;
  label: string;
  description: string;
  testCount: number;
}

export const TEST_PLAN_DEPTHS: TestPlanDepthOption[] = [
  {
    id: "smoke",
    label: "Smoke",
    description:
      "Highest-yield tests only — fast pass to find the obvious critical and high findings.",
    testCount: TIER_TEST_IDS.smoke.length,
  },
  {
    id: "standard",
    label: "Standard",
    description:
      "Balanced coverage across every WSTG v4.2 category, suitable for most engagements.",
    testCount: TIER_TEST_IDS.standard.length,
  },
  {
    id: "deep",
    label: "Deep",
    description:
      "Standard coverage plus the low-yield, high-effort tests and client-side edge cases.",
    testCount: TIER_TEST_IDS.deep.length,
  },
  {
    id: "full",
    label: "Full",
    description: `Complete WSTG v${WSTG_VERSION} coverage: all ${WSTG_TESTS.length} test cases.`,
    testCount: TIER_TEST_IDS.full.length,
  },
];

export interface TestPlanCoverageRow {
  key: string;
  label: string;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  notStarted: number;
}

export interface TestPlanCoverage {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  inProgress: number;
  notStarted: number;
  skipped: number;
  percentExecuted: number;
  percentPassed: number;
  byCategory: TestPlanCoverageRow[];
  byOwasp: TestPlanCoverageRow[];
}

export interface CreateTestPlanInput {
  target?: string;
  scope?: string;
  notes?: string;
  depth?: unknown;
  categories?: string[];
  testIds?: string[];
  existing?: WebAppTestPlanDoc | null;
}

export interface UpdateTestCasePatch {
  status?: unknown;
  notes?: string;
  observations?: string;
  linkedVulnerabilityIds?: string[];
  addLinkedVulnerabilityId?: string;
}

export function normalizeDepth(value: unknown): TestPlanDepth {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = TEST_PLAN_DEPTHS.find((depth) => depth.id === raw);
  return match ? match.id : "standard";
}

export function normalizeTestStatus(value: unknown): WstgTestStatus | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = TEST_STATUSES.find((status) => status === raw);
  if (match) return match;
  const aliases: Record<string, WstgTestStatus> = {
    pass: "passed",
    ok: "passed",
    vulnerable: "failed",
    fail: "failed",
    finding: "failed",
    findings: "failed",
    running: "in_progress",
    started: "in_progress",
    todo: "not_started",
    pending: "not_started",
    none: "not_started",
    n_a: "skipped",
    na: "skipped",
  };
  return aliases[raw];
}

export function isWstgCategoryCode(value: unknown): boolean {
  return (
    typeof value === "string" &&
    WSTG_CATEGORIES.some((category) => category.code === value.trim().toUpperCase())
  );
}

/** Test ids selected by a depth tier, optionally narrowed to WSTG categories. */
export function selectTestIds(options: {
  depth?: unknown;
  categories?: string[];
  testIds?: string[];
}): string[] {
  const depth = normalizeDepth(options.depth);
  const explicit = (options.testIds ?? [])
    .map((id) => normalizeWstgId(id))
    .filter((id) => !!getWstgTest(id));
  const baseIds = explicit.length ? explicit : TIER_TEST_IDS[depth];

  const categories = new Set(
    (options.categories ?? [])
      .map((code) => String(code).trim().toUpperCase())
      .filter((code) => isWstgCategoryCode(code)),
  );

  const ids = categories.size
    ? baseIds.filter((id) => {
        const test = getWstgTest(id);
        return !!test && categories.has(test.category);
      })
    : [...baseIds];

  return ids
    .filter((id, index) => ids.indexOf(id) === index)
    .sort((a, b) => priorityIndex(a) - priorityIndex(b));
}

function priorityIndex(testId: string): number {
  const rank = PLAN_PRIORITY.get(testId);
  if (rank !== undefined) return rank;
  const catalogIndex = WSTG_TESTS.findIndex((test) => test.id === testId);
  return WSTG_TESTS.length + (catalogIndex < 0 ? 0 : catalogIndex);
}

export function buildTestCase(test: WstgTest): SessionTestCaseDoc {
  return {
    testId: test.id,
    section: test.section,
    categoryCode: test.category,
    categoryName: categoryNameFor(test.category),
    title: test.title,
    objective: test.objective,
    howToTest: test.howToTest,
    owasp: [...test.owasp],
    cwe: [...test.cwe],
    tools: [...test.tools],
    evidenceExpectation: test.evidence,
    status: "not_started",
    notes: "",
    observations: "",
    linkedVulnerabilityIds: [],
    updatedAt: new Date(),
  };
}

function categoryNameFor(code: string): string {
  return WSTG_CATEGORIES.find((category) => category.code === code)?.name ?? code;
}

export function createTestPlan(input: CreateTestPlanInput): {
  plan: WebAppTestPlanDoc;
  added: number;
  kept: number;
  coverage: TestPlanCoverage;
} {
  const depth = normalizeDepth(input.depth ?? input.existing?.depth);
  const categories = (input.categories ?? [])
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => isWstgCategoryCode(code));
  const testIds = selectTestIds({ depth, categories, testIds: input.testIds });

  const previous = new Map(
    (input.existing?.cases ?? []).map((testCase) => [testCase.testId, testCase] as const),
  );

  let added = 0;
  let kept = 0;
  const cases: SessionTestCaseDoc[] = [];
  for (const testId of testIds) {
    const test = getWstgTest(testId);
    if (!test) continue;
    const existingCase = previous.get(testId);
    if (existingCase) {
      kept += 1;
      cases.push({
        ...existingCase,
        section: test.section,
        categoryCode: test.category,
        categoryName: categoryNameFor(test.category),
        title: test.title,
        objective: test.objective,
        howToTest: test.howToTest,
        owasp: [...test.owasp],
        cwe: [...test.cwe],
        tools: [...test.tools],
        evidenceExpectation: test.evidence,
      });
      continue;
    }
    added += 1;
    cases.push(buildTestCase(test));
  }

  const now = new Date();
  const plan: WebAppTestPlanDoc = {
    source: TEST_PLAN_SOURCE,
    version: WSTG_VERSION,
    target: input.target ?? input.existing?.target ?? "",
    scope: input.scope ?? input.existing?.scope ?? "",
    notes: input.notes ?? input.existing?.notes ?? "",
    depth,
    categories: categories.length
      ? categories
      : (input.existing?.categories ?? []).filter((code) => isWstgCategoryCode(code)),
    cases,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
  };

  return { plan, added, kept, coverage: computeCoverage(cases) };
}

export function updateTestCase(
  plan: WebAppTestPlanDoc,
  testId: string,
  patch: UpdateTestCasePatch,
): { plan: WebAppTestPlanDoc; testCase: SessionTestCaseDoc } | undefined {
  const id = normalizeWstgId(testId);
  const index = plan.cases.findIndex((testCase) => testCase.testId === id);
  if (index < 0) return undefined;

  const current = plan.cases[index];
  const status = normalizeTestStatus(patch.status) ?? current.status;
  const linked = new Set(current.linkedVulnerabilityIds ?? []);
  for (const vulnerabilityId of patch.linkedVulnerabilityIds ?? []) {
    if (typeof vulnerabilityId === "string" && vulnerabilityId.trim()) {
      linked.add(vulnerabilityId.trim());
    }
  }
  if (patch.addLinkedVulnerabilityId?.trim()) {
    linked.add(patch.addLinkedVulnerabilityId.trim());
  }

  const testCase: SessionTestCaseDoc = {
    ...current,
    status,
    notes: patch.notes ?? current.notes,
    observations: patch.observations ?? current.observations,
    linkedVulnerabilityIds: Array.from(linked),
    updatedAt: new Date(),
  };

  const cases = [...plan.cases];
  cases[index] = testCase;
  return { plan: { ...plan, cases, updatedAt: new Date() }, testCase };
}

export function computeCoverage(cases: SessionTestCaseDoc[]): TestPlanCoverage {
  const count = (status: WstgTestStatus) =>
    cases.filter((testCase) => testCase.status === status).length;

  const passed = count("passed");
  const failed = count("failed");
  const blocked = count("blocked");
  const inProgress = count("in_progress");
  const notStarted = count("not_started");
  const skipped = count("skipped");
  const total = cases.length;
  const executed = passed + failed + blocked;

  const percentage = (value: number) =>
    total === 0 ? 0 : Math.round((value / total) * 1000) / 10;

  const groupBy = (
    keyOf: (testCase: SessionTestCaseDoc) => string[],
    labelOf: (key: string) => string,
  ): TestPlanCoverageRow[] => {
    const rows = new Map<string, TestPlanCoverageRow>();
    for (const testCase of cases) {
      for (const key of keyOf(testCase)) {
        const row =
          rows.get(key) ??
          {
            key,
            label: labelOf(key),
            total: 0,
            executed: 0,
            passed: 0,
            failed: 0,
            blocked: 0,
            notStarted: 0,
          };
        row.total += 1;
        if (testCase.status === "passed") row.passed += 1;
        if (testCase.status === "failed") row.failed += 1;
        if (testCase.status === "blocked") row.blocked += 1;
        if (testCase.status === "not_started") row.notStarted += 1;
        if (["passed", "failed", "blocked"].includes(testCase.status)) {
          row.executed += 1;
        }
        rows.set(key, row);
      }
    }
    return Array.from(rows.values());
  };

  return {
    total,
    executed,
    passed,
    failed,
    blocked,
    inProgress,
    notStarted,
    skipped,
    percentExecuted: percentage(executed),
    percentPassed: percentage(passed),
    byCategory: groupBy(
      (testCase) => [testCase.categoryCode],
      (code) => categoryNameFor(code),
    ).sort((a, b) => a.key.localeCompare(b.key)),
    byOwasp: groupBy(
      (testCase) =>
        testCase.owasp
          .map((id) => normalizeOwaspTop10Id(id))
          .filter((id): id is OwaspTop10Id => !!id),
      (id) => getOwaspCategory(id)?.title ?? id,
    ).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Tests the agent should run next: highest-yield work that has not been touched. */
export function nextTestsToRun(
  plan: WebAppTestPlanDoc,
  limit = 10,
): SessionTestCaseDoc[] {
  return plan.cases
    .filter((testCase) => testCase.status === "not_started")
    .sort((a, b) => priorityIndex(a.testId) - priorityIndex(b.testId))
    .slice(0, limit);
}

function statusGlyph(status: WstgTestStatus): string {
  const glyphs: Record<WstgTestStatus, string> = {
    not_started: "[ ]",
    in_progress: "[~]",
    passed: "[v]",
    failed: "[x]",
    blocked: "[!]",
    skipped: "[-]",
  };
  return glyphs[status];
}

/**
 * Compact prompt section: enough for the agent to know where it is without
 * spending context on the whole 97-case catalogue.
 */
export function renderTestPlanPrompt(
  plan: WebAppTestPlanDoc,
  options?: { maxNext?: number; maxFailures?: number },
): string {
  const coverage = computeCoverage(plan.cases);
  const maxNext = options?.maxNext ?? 10;
  const maxFailures = options?.maxFailures ?? 12;

  const lines: string[] = [
    `<wstg_test_plan source="${plan.source}" depth="${plan.depth}" target="${plan.target || "undefined"}">`,
    `Coverage: ${coverage.executed}/${coverage.total} executed (${coverage.percentExecuted}%) — ${coverage.passed} passed, ${coverage.failed} failed, ${coverage.blocked} blocked, ${coverage.inProgress} in progress, ${coverage.notStarted} not started, ${coverage.skipped} skipped.`,
  ];

  if (plan.scope) lines.push(`Scope: ${plan.scope}`);

  lines.push(
    "By category: " +
      coverage.byCategory
        .map((row) => `${row.key} ${row.executed}/${row.total}`)
        .join(", "),
  );

  const failed = plan.cases.filter((testCase) => testCase.status === "failed");
  if (failed.length) {
    lines.push("", "Tests that produced findings (link every finding to its test):");
    for (const testCase of failed.slice(0, maxFailures)) {
      lines.push(
        `- ${statusGlyph(testCase.status)} ${testCase.testId} (${testCase.section}) ${testCase.title} — ${testCase.owasp.join(", ")}${
          testCase.observations ? ` — observed: ${truncate(testCase.observations, 160)}` : ""
        }`,
      );
    }
    if (failed.length > maxFailures) {
      lines.push(`- ...and ${failed.length - maxFailures} more failed tests (see the Test Plan view).`);
    }
  }

  const blocked = plan.cases.filter((testCase) => testCase.status === "blocked");
  if (blocked.length) {
    lines.push("", "Blocked tests (state what is missing):");
    for (const testCase of blocked.slice(0, 6)) {
      lines.push(`- ${testCase.testId} ${testCase.title} — ${testCase.notes || "no reason recorded"}`);
    }
  }

  const next = nextTestsToRun(plan, maxNext);
  if (next.length) {
    lines.push("", "Next tests by priority:");
    for (const testCase of next) {
      lines.push(
        `- ${testCase.testId} (${testCase.section}) ${testCase.title} — ${testCase.owasp.join(", ")} — objective: ${testCase.objective}`,
      );
    }
    if (coverage.notStarted > next.length) {
      lines.push(`- ...plus ${coverage.notStarted - next.length} more not started.`);
    }
  }

  lines.push(
    "",
    'Update progress with the `wstg_test_plan` tool: action "update_case" (test_id + status) after every test, action "get" when you need the full method for a case, and action "coverage" to re-check where you are.',
    "</wstg_test_plan>",
  );

  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}