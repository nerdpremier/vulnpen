/**
 * OWASP WSTG v4.2 test planning for the Web Application Security Testing assistant.
 *
 * A session owns one test plan. By default the plan covers the full WSTG v4.2
 * catalogue (see ../../knowledge), optionally narrowed to a few categories or a
 * shortlist of test ids. The agent and the user can also add custom cases that
 * are not part of the catalogue. The plan is persisted in the session document
 * and re-injected into the system prompt on every turn, so coverage survives
 * context summarisation.
 *
 * The plan deliberately carries no OWASP Top 10 / CWE pre-mapping: mapping
 * belongs to actual findings on the Vulnerabilities page, not to planned tests.
 */

import {
  WSTG_CATEGORIES,
  WSTG_TESTS,
  WSTG_VERSION,
  getWstgTest,
  normalizeWstgId,
} from "../../knowledge";
import type { WstgTest, WstgTestStatus } from "../../knowledge";
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
 * Controllers read the plan straight off a mongoose session document, whose fields sit behind
 * non-enumerable getters: spreading one copies only internals (source, target, scope and the
 * rest vanish) and Mongo then reports "no change". Every helper that hands a plan back to be
 * persisted normalises it to plain data first.
 */
function toPlainPlan(plan: WebAppTestPlanDoc): WebAppTestPlanDoc {
  const hydrated = plan as unknown as { toObject?: () => unknown };
  if (typeof hydrated?.toObject === "function") {
    return hydrated.toObject() as WebAppTestPlanDoc;
  }
  return plan;
}
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
}

export interface CreateTestPlanInput {
  target?: string;
  scope?: string;
  categories?: string[];
  testIds?: string[];
  existing?: WebAppTestPlanDoc | null;
}

export interface UpdateTestCasePatch {
  title?: string;
  objective?: string;
  howToTest?: string;
  status?: unknown;
  notes?: string;
  observations?: string;
  linkedVulnerabilityIds?: string[];
  addLinkedVulnerabilityId?: string;
}

export interface AddTestCaseInput {
  testId?: string;
  title?: unknown;
  objective?: unknown;
  howToTest?: unknown;
  categoryCode?: unknown;
  notes?: unknown;
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

/** Test ids from the WSTG catalogue, optionally narrowed to categories, in catalogue order. */
export function selectTestIds(options: {
  categories?: string[];
  testIds?: string[];
}): string[] {
  const explicit = (options.testIds ?? [])
    .map((id) => normalizeWstgId(id))
    .filter((id) => !!getWstgTest(id));
  const baseIds = explicit.length ? explicit : WSTG_TESTS.map((test) => test.id);

  const categories = new Set(
    (options.categories ?? [])
      .map((code) => String(code).trim().toUpperCase())
      .filter((code) => isWstgCategoryCode(code)),
  );
  // A category list that is present but empty means "nothing ticked": no catalogue cases at all.
  // Only an absent list leaves the selection unfiltered, which is the whole guide.
  if (Array.isArray(options.categories) && !categories.size) return [];

  const ids = categories.size
    ? baseIds.filter((id) => {
        const test = getWstgTest(id);
        return !!test && categories.has(test.category);
      })
    : [...baseIds];

  // Keep catalogue order: WSTG_TESTS defines the sequence, so sort by it.
  const catalogueIndex = new Map(WSTG_TESTS.map((test, index) => [test.id, index] as const));
  return ids
    .filter((id, index) => ids.indexOf(id) === index)
    .sort((a, b) => (catalogueIndex.get(a) ?? 0) - (catalogueIndex.get(b) ?? 0));
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

/** Index in the WSTG v4.2 section order (4.1 INFO → 4.12 …); unknown codes sort last. */
const CATEGORY_ORDER = new Map<string, number>(
  WSTG_CATEGORIES.map((category, index) => [category.code as string, index]),
);
function categoryOrder(code: string): number {
  return CATEGORY_ORDER.get(code) ?? CATEGORY_ORDER.size;
}

/** A test id that does not belong to the static WSTG catalogue (e.g. CUSTOM-01). */
export function isCustomTestId(testId: string): boolean {
  return !getWstgTest(testId);
}

/**
 * Create a SessionTestCaseDoc for a custom case that is not part of the WSTG
 * catalogue. The testId is not validated against the catalogue: the caller may
 * pass a deterministic id or let the service generate CUSTOM-NN.
 */
export function addTestCase(
  plan: WebAppTestPlanDoc,
  input: AddTestCaseInput,
): { plan: WebAppTestPlanDoc; testCase: SessionTestCaseDoc } | undefined {
  const base = toPlainPlan(plan);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return undefined;

  const existingIds = new Set(base.cases.map((testCase) => testCase.testId.toUpperCase()));
  let testId =
    typeof input.testId === "string" ? input.testId.trim() : "";
  if (testId && existingIds.has(testId.toUpperCase())) return undefined;
  if (!testId) {
    const prefix = "CUSTOM-";
    let counter = 1;
    while (existingIds.has(`${prefix}${String(counter).padStart(2, "0")}`)) counter += 1;
    testId = `${prefix}${String(counter).padStart(2, "0")}`;
  }

  const rawCategory = typeof input.categoryCode === "string" ? input.categoryCode.trim() : "";
  const categoryCode = isWstgCategoryCode(rawCategory) ? rawCategory.toUpperCase() : rawCategory;

  const testCase: SessionTestCaseDoc = {
    testId,
    section: "",
    categoryCode,
    categoryName: categoryNameFor(categoryCode),
    title,
    objective: typeof input.objective === "string" ? input.objective.trim() : "",
    howToTest: typeof input.howToTest === "string" ? input.howToTest.trim() : "",
    tools: [],
    evidenceExpectation: "",
    status: "not_started",
    notes: typeof input.notes === "string" ? input.notes.trim() : "",
    observations: "",
    linkedVulnerabilityIds: [],
    updatedAt: new Date(),
  };

  return { plan: { ...base, cases: [...base.cases, testCase], updatedAt: new Date() }, testCase };
}

/**
 * Generic words that say nothing about what a case actually tests; stripped
 * before comparing a proposed custom case against the plan.
 */
const DUPLICATE_STOPWORDS = new Set([
  "testing", "test", "for", "and", "or", "the", "a", "an", "of", "in", "on",
  "to", "with", "without", "missing", "weak", "misconfiguration", "via",
  "using", "against", "checks", "check", "checksfor", "absence", "presence",
  "vulnerabilities", "vulnerability", "security", "assess", "assessing",
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
      (token) => !DUPLICATE_STOPWORDS.has(token),
    ),
  );
}

export interface DuplicateCaseHit {
  testId: string;
  title: string;
  sharedTokens: string[];
}

/**
 * Find plan cases that already cover what a proposed custom case describes.
 * A case counts as a near-duplicate when it shares several significant words
 * in title/objective, or shares any significant word within the same WSTG
 * category — a brute-force case, say, should not be re-added next to the
 * lock-out test that already failed.
 */
export function findDuplicateCases(
  plan: WebAppTestPlanDoc,
  input: { title: string; objective?: string; categoryCode?: string },
): DuplicateCaseHit[] {
  const proposed = significantTokens(`${input.title} ${input.objective ?? ""}`);
  if (!proposed.size) return [];
  const category =
    typeof input.categoryCode === "string" ? input.categoryCode.trim().toUpperCase() : "";

  const hits: DuplicateCaseHit[] = [];
  for (const testCase of plan.cases) {
    const existing = significantTokens(
      `${testCase.title} ${testCase.objective} ${testCase.howToTest ?? ""}`,
    );
    const shared = [...proposed].filter((token) => existing.has(token));
    const sameCategory =
      !!category && testCase.categoryCode.toUpperCase() === category;
    if (shared.length >= 2 || (sameCategory && shared.length >= 1)) {
      hits.push({ testId: testCase.testId, title: testCase.title, sharedTokens: shared.slice(0, 6) });
    }
  }
  return hits;
}

/** Catalogue position of a test id; hand-added cases sort after every catalogue case. */
const CATALOGUE_ORDER = new Map<string, number>(
  WSTG_TESTS.map((test, index) => [test.id, index] as const),
);

/**
 * Catalogue cases first, in the guide's own section order, then hand-added cases in the
 * order they were added (Array#sort is stable), so a plan always reads like the guide.
 */
function sortCatalogueFirst(cases: SessionTestCaseDoc[]): SessionTestCaseDoc[] {
  return [...cases].sort(
    (a, b) =>
      (CATALOGUE_ORDER.get(a.testId) ?? Number.MAX_SAFE_INTEGER) -
      (CATALOGUE_ORDER.get(b.testId) ?? Number.MAX_SAFE_INTEGER),
  );
}

export interface AddCatalogueCasesResult {
  plan: WebAppTestPlanDoc;
  /** Cases that were appended to the plan. */
  added: SessionTestCaseDoc[];
  /** Requested ids that the plan already holds. */
  skipped: string[];
  /** Requested ids that are not part of the WSTG v4.2 catalogue. */
  unknown: string[];
}

/**
 * Append WSTG catalogue cases to an existing plan. Ids may be written as "WSTG-INPV-05",
 * "inpv-5" or the section "4.7.5". A case already in the plan keeps the result it
 * carries, and unknown ids are reported back instead of failing the whole call.
 */
export function addCatalogueCases(
  plan: WebAppTestPlanDoc,
  testIds: unknown[],
): AddCatalogueCasesResult {
  const base = toPlainPlan(plan);
  const planned = new Set(base.cases.map((testCase) => testCase.testId.toUpperCase()));
  const added: SessionTestCaseDoc[] = [];
  const skipped: string[] = [];
  const unknown: string[] = [];

  for (const raw of testIds) {
    const test = getWstgTest(raw);
    if (!test) {
      const label = typeof raw === "string" ? raw.trim() : "";
      if (label) unknown.push(label);
      continue;
    }
    if (planned.has(test.id.toUpperCase())) {
      skipped.push(test.id);
      continue;
    }
    planned.add(test.id.toUpperCase());
    added.push(buildTestCase(test));
  }

  if (!added.length) return { plan: base, added, skipped, unknown };

  return {
    plan: {
      ...base,
      cases: sortCatalogueFirst([...base.cases, ...added]),
      updatedAt: new Date(),
    },
    added,
    skipped,
    unknown,
  };
}

/**
 * Drop cases from the plan by test id. Returns undefined when none of the ids belong to
 * the plan, so the API can answer 404 instead of pretending it deleted something.
 */
export function removeCases(
  plan: WebAppTestPlanDoc,
  testIds: unknown[],
): { plan: WebAppTestPlanDoc; removed: string[] } | undefined {
  const wanted = new Set(
    testIds
      .filter((testId): testId is string => typeof testId === "string" && !!testId.trim())
      .map((testId) => testId.trim().toUpperCase()),
  );
  if (!wanted.size) return undefined;

  const base = toPlainPlan(plan);
  const removed = base.cases
    .filter((testCase) => wanted.has(testCase.testId.toUpperCase()))
    .map((testCase) => testCase.testId);
  if (!removed.length) return undefined;

  return {
    plan: {
      ...base,
      cases: base.cases.filter((testCase) => !wanted.has(testCase.testId.toUpperCase())),
      updatedAt: new Date(),
    },
    removed,
  };
}

export function removeCase(
  plan: WebAppTestPlanDoc,
  testId: string,
): { plan: WebAppTestPlanDoc; testId: string } | undefined {
  const result = removeCases(plan, [testId]);
  if (!result) return undefined;
  return { plan: result.plan, testId: result.removed[0] };
}

export function createTestPlan(input: CreateTestPlanInput): {
  plan: WebAppTestPlanDoc;
  added: number;
  kept: number;
  coverage: TestPlanCoverage;
} {
  const categories = (input.categories ?? [])
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => isWstgCategoryCode(code));
  const testIds = selectTestIds({
    // Only pass a list when one was given: an absent list means "no filter", an empty one "nothing".
    categories: Array.isArray(input.categories) ? categories : undefined,
    testIds: input.testIds,
  });

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
        tools: [...test.tools],
        evidenceExpectation: test.evidence,
      });
      continue;
    }
    added += 1;
    cases.push(buildTestCase(test));
  }

  // Keep custom cases (not part of the catalogue) across regenerations.
  for (const existingCase of input.existing?.cases ?? []) {
    if (!getWstgTest(existingCase.testId) && !cases.some((c) => c.testId === existingCase.testId)) {
      kept += 1;
      cases.push(existingCase);
    }
  }

  const now = new Date();
  const plan: WebAppTestPlanDoc = {
    source: TEST_PLAN_SOURCE,
    version: WSTG_VERSION,
    target: input.target ?? input.existing?.target ?? "",
    scope: input.scope ?? input.existing?.scope ?? "",
    // Record exactly what was asked for, so an explicit empty list stays empty.
    categories: Array.isArray(input.categories)
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
  // Match any id present in the plan (WSTG or custom); normalize only as a hint.
  const base = toPlainPlan(plan);
  const id = normalizeWstgId(testId);
  const index = base.cases.findIndex(
    (testCase) => testCase.testId === id || testCase.testId.toUpperCase() === testId.trim().toUpperCase(),
  );
  if (index < 0) return undefined;

  const current = base.cases[index];
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
    title: patch.title?.trim() || current.title,
    objective: patch.objective !== undefined ? patch.objective : current.objective,
    howToTest: patch.howToTest !== undefined ? patch.howToTest : current.howToTest,
    status,
    notes: patch.notes ?? current.notes,
    observations: patch.observations ?? current.observations,
    linkedVulnerabilityIds: Array.from(linked),
    updatedAt: new Date(),
  };

  const cases = [...base.cases];
  cases[index] = testCase;
  return { plan: { ...base, cases, updatedAt: new Date() }, testCase };
}

/** A case marked "failed" claims the test produced a vulnerability, so it
 *  must end up with a linked finding — otherwise coverage counts a failure
 *  the report can never trace back. Returns the refusal message for the
 *  update_case handler, or undefined when the patch is acceptable. */
export function caseUpdateError(
  plan: WebAppTestPlanDoc,
  testId: string,
  patch: UpdateTestCasePatch,
): string | undefined {
  const preview = updateTestCase(plan, testId, patch);
  if (!preview) return undefined;
  const testCase = preview.testCase;
  if (testCase.status === "failed" && !testCase.linkedVulnerabilityIds?.length) {
    return (
      `"update_case" refused: status "failed" claims the test produced a vulnerability, ` +
      `so a finding must be linked to it. Record the finding first with update_engagement_state ` +
      `action "add_vulnerability" (data.wstgId = ${testCase.testId}) — recording it with wstgId also ` +
      `links the case automatically — then retry this call with vulnerability_id set to the new ` +
      `finding id. If the test ran and found nothing, mark it "passed"; if you could not complete ` +
      `it, use "blocked" or "skipped" with a note.`
    );
  }
  return undefined;
}

/** Look a plan case up by test id, tolerating case differences ("wstg-inpv-05"). */
export function findPlanCase(
  plan: WebAppTestPlanDoc,
  testId: string,
): SessionTestCaseDoc | undefined {
  const wanted = String(testId ?? "").trim().toUpperCase();
  if (!wanted) return undefined;
  return plan.cases.find(
    (testCase) => testCase.testId.toUpperCase() === wanted,
  );
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
    ).sort((a, b) => categoryOrder(a.key) - categoryOrder(b.key)),
  };
}

/** Tests the agent should run next: untouched work, in plan order. */
export function nextTestsToRun(
  plan: WebAppTestPlanDoc,
  limit = 10,
): SessionTestCaseDoc[] {
  return plan.cases
    .filter((testCase) => testCase.status === "not_started")
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
    `<wstg_test_plan source="${plan.source}" target="${plan.target || "undefined"}">`,
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
        `- ${statusGlyph(testCase.status)} ${testCase.testId} (${testCase.section}) ${testCase.title}${
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
    lines.push("", "Next tests (plan order):");
    for (const testCase of next) {
      lines.push(
        `- ${testCase.testId} (${testCase.section}) ${testCase.title} — objective: ${testCase.objective}`,
      );
    }
    if (coverage.notStarted > next.length) {
      lines.push(`- ...plus ${coverage.notStarted - next.length} more not started.`);
    }
  }

  lines.push(
    "",
    'Update progress with the `wstg_test_plan` tool: action "update_case" (test_id + status) after every test, action "add_case" for custom cases that are not in the catalogue, action "get" when you need the full method for a case, and action "coverage" to re-check where you are.',
    "</wstg_test_plan>",
  );

  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
