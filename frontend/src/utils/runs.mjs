/**
 * Pure helpers for the Nessus-style run history on the case detail page:
 * progress of a live run, human durations, and finding the run that owns a
 * case right now.
 */

/** "45s" / "12m 05s" / "1h 03m" — the duration column of the history table. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// Only cases the run could actually settle count toward live progress — a
// case already "skipped" before the run says nothing about how far it is.
const DONE_STATUSES = new Set(["passed", "failed", "blocked"]);

/**
 * Live progress of a run: how many of its cases have settled according to the
 * plan (the agent updates case status as it works), plus the result counts the
 * history row shows. `planCases` may be null — the row then shows 0/total.
 */
export function runProgressFromPlan(testIds, planCases) {
  const total = (testIds ?? []).length;
  const byId = new Map((planCases ?? []).map((testCase) => [testCase.testId, testCase.status]));
  const counts = { passed: 0, failed: 0, blocked: 0, other: 0 };
  let done = 0;
  for (const testId of testIds ?? []) {
    const status = byId.get(testId);
    if (!DONE_STATUSES.has(status)) continue;
    done += 1;
    if (status === "passed") counts.passed += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "blocked") counts.blocked += 1;
    else counts.other += 1;
  }
  return {
    total,
    done,
    percent: total ? Math.round((done / total) * 100) : 0,
    counts,
  };
}

/**
 * The run that currently owns a case (queued or running), newest first —
 * drives the header's "running" pill and the auto-expanded history row.
 */
export function activeRunForCase(runs, testId) {
  return (
    (runs ?? []).find(
      (run) =>
        (run.status === "queued" || run.status === "running") &&
        (run.testIds ?? []).includes(testId),
    ) ?? null
  );
}

/** The headline of a finished row: "2 failed · 1 blocked" style result. */
export function describeRunResult(summary) {
  if (!summary?.counts) return "";
  const parts = [];
  if (summary.counts.passed) parts.push(`${summary.counts.passed} passed`);
  if (summary.counts.failed) parts.push(`${summary.counts.failed} failed`);
  if (summary.counts.blocked) parts.push(`${summary.counts.blocked} blocked`);
  return parts.join(" · ");
}
