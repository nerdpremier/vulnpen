// Pure test-plan projections. Extracted from TestPlanPage.jsx so the grouping,
// filtering, and coverage math are testable without mounting React. The page
// only renders what these return.

/** Group key for cases that do not belong to one of the twelve WSTG categories. */
export const OTHER_GROUP = "OTHER";

/** The result values a case status control offers, shared by the plan table and the detail page. */
export const STATUS_OPTIONS = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "blocked", label: "Blocked" },
  { value: "skipped", label: "Skipped" },
];

// Status strings as stored on a case, mapped to the camelCase buckets the UI
// reads. Kept as an explicit table because testCase.status ("in_progress")
// does not match the bucket keys ("inProgress") — looking them up as one word
// silently zeroes the bucket.
const STATUS_TO_BUCKET = {
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  in_progress: "inProgress",
  skipped: "skipped",
  not_started: "notStarted",
};

/** Execution totals for one set of cases. */
export function summarise(cases) {
  const counts = { passed: 0, failed: 0, blocked: 0, inProgress: 0, skipped: 0, notStarted: 0 };
  for (const testCase of cases) {
    const bucket = STATUS_TO_BUCKET[testCase.status];
    if (bucket !== undefined) counts[bucket] += 1;
  }
  const total = cases.length;
  const executed = counts.passed + counts.failed + counts.blocked;
  return { ...counts, total, executed, percent: total ? Math.round((executed / total) * 100) : 0 };
}

/**
 * The plan grouped by WSTG category, in catalogue order. Cases the assistant added by hand land in
 * a trailing "Other" group, and empty groups are dropped so no empty headings are drawn.
 */
export function groupCases(cases, categories) {
  const groups = (categories ?? []).map((category) => ({
    key: category.code,
    code: category.code,
    section: category.section,
    name: category.name,
    cases: [],
  }));
  const position = new Map(groups.map((group, index) => [group.key, index]));
  const other = { key: OTHER_GROUP, code: "", section: "", name: "Other test cases", cases: [] };

  for (const testCase of cases) {
    const index = position.get(testCase.categoryCode);
    (index === undefined ? other : groups[index]).cases.push(testCase);
  }

  return [...groups, other].filter((group) => group.cases.length > 0);
}

export function matchesFilters(testCase, needle, status) {
  if (status !== "all" && testCase.status !== status) return false;
  if (!needle) return true;
  const lowered = needle.toLowerCase();
  return [testCase.testId, testCase.section, testCase.title, testCase.objective, testCase.observations]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(lowered));
}

/** True when dropping a case would throw away something a tester recorded. */
export function caseCarriesWork(testCase) {
  return (
    testCase.status !== "not_started" ||
    Boolean(testCase.observations?.trim()) ||
    Boolean(testCase.notes?.trim()) ||
    (testCase.linkedVulnerabilityIds?.length ?? 0) > 0
  );
}

/**
 * Selection semantics for the plan table's checkboxes, pure so the rules are
 * testable without the page: only cases still in the plan may stay selected,
 * and toggles return new Sets so React state updates stay immutable.
 */

/** The selection narrowed to the cases the plan still contains. */
export function activeSelection(selectedIds, cases) {
  if (selectedIds.size === 0) return selectedIds;
  const planned = new Set(cases.map((testCase) => testCase.testId));
  return new Set([...selectedIds].filter((id) => planned.has(id)));
}

/** One checkbox flip. */
export function toggledSelection(selectedIds, testId) {
  const next = new Set(selectedIds);
  if (next.has(testId)) next.delete(testId);
  else next.add(testId);
  return next;
}

/** A group checkbox: add or remove every listed id. */
export function selectionWith(selectedIds, testIds, checked) {
  const next = new Set(selectedIds);
  for (const testId of testIds) {
    if (checked) next.add(testId);
    else next.delete(testId);
  }
  return next;
}

/**
 * The group open policy: an explicit override wins; with a filter on, every
 * group with matches is open; the deep-linked focus case opens its group;
 * otherwise only categories already carrying a failed or blocked case are.
 * Filters never write overrides, so clearing one returns the plan to the calm,
 * collapsed view.
 */
export function groupIsOpen(
  group,
  { overrides, filtersActive = false, focusCaseId = "" } = {},
) {
  if (overrides && overrides.has(group.key)) return overrides.get(group.key);
  if (filtersActive) return true;
  if (
    focusCaseId &&
    group.cases.some((testCase) => testCase.testId.toUpperCase() === focusCaseId)
  ) {
    return true;
  }
  return group.cases.some(
    (testCase) => testCase.status === "failed" || testCase.status === "blocked",
  );
}

/**
 * The status chips are the status filter: one chip per filter the coverage can
 * answer for, with the count each shows. `filters` is the page's filter list
 * (value + label); the "all" chip always shows.
 */
export function coverageChips(coverage, filters) {
  if (!coverage) return [];
  const counts = {
    all: coverage.total,
    in_progress: coverage.inProgress,
    passed: coverage.passed,
    failed: coverage.failed,
    blocked: coverage.blocked,
    not_started: coverage.notStarted,
    skipped: coverage.skipped,
  };
  return filters
    .filter((filter) => filter.value === "all" || counts[filter.value] > 0)
    .map((filter) => ({ ...filter, count: counts[filter.value] }));
}
