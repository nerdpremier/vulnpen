/**
 * Pure helpers for the Nessus-style scans pages: what a scan is called, how
 * far it has come, which cases a launcher selection resolves to, and the
 * headlines of the scan list. The pages only render what these return.
 *
 * Vocabulary: a **scan** is one execution of a set of WSTG cases. The backend
 * persists it as a run record, so the API fields still read `run*`.
 */

/** "45s" / "12m 05s" / "1h 03m" — the duration column of the scan table. */
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

// A case is settled once the agent recorded an outcome for it. `skipped` is an
// outcome too — it is just not a test result, so it is counted on its own.
const DONE_STATUSES = new Set(["passed", "failed", "blocked"]);

/**
 * A scan that is still moving: queued or running. Everything in the product
 * that polls, animates or warns keys off this one predicate — the rail badge,
 * the list's refresh interval and the progress bar all have to agree on what
 * "live" means.
 */
export function isScanLive(scan) {
  return scan?.status === "queued" || scan?.status === "running";
}

/** The cases a row reports on: the scan's own snapshot, else the live plan. */
export function scanCaseStatuses(scan, planCases) {
  const snapshot = scan?.resultSummary?.perCase;
  if (snapshot?.length) return snapshot;
  return (scan?.testIds ?? []).map((testId) => ({
    testId,
    status:
      (planCases ?? []).find((testCase) => testCase.testId === testId)?.status ??
      "not_started",
  }));
}

/**
 * How a scan's cases ended, one bucket each. `notExecuted` covers what the
 * scan never got to (not started, or still in progress when it stopped).
 */
export function countScanCases(perCase) {
  const counts = {
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    notExecuted: 0,
  };
  for (const entry of perCase ?? []) {
    counts.total += 1;
    if (entry?.status === "passed") counts.passed += 1;
    else if (entry?.status === "failed") counts.failed += 1;
    else if (entry?.status === "blocked") counts.blocked += 1;
    else if (entry?.status === "skipped") counts.skipped += 1;
    else counts.notExecuted += 1;
  }
  return counts;
}

/**
 * Live progress of a scan: how many of its cases this scan has settled.
 *
 * A case carries the plan's status, which a previous scan may already have
 * settled — so a re-test would otherwise start at 100%. `since` (the scan's
 * start) restricts the count to the cases the agent has written to during this
 * scan; without it (a finished scan, or a plan that predates the field) every
 * settled case counts. Pure, so the same rule drives the list and the detail
 * page.
 */
export function scanProgress(testIds, planCases, { since } = {}) {
  const started = since ? new Date(since).getTime() : null;
  const byId = new Map((planCases ?? []).map((testCase) => [testCase.testId, testCase]));
  const settled = [];
  for (const testId of testIds ?? []) {
    const testCase = byId.get(testId);
    if (!DONE_STATUSES.has(testCase?.status)) continue;
    if (started != null) {
      const touched = testCase.updatedAt ? new Date(testCase.updatedAt).getTime() : null;
      // No timestamp to compare against (an older plan) — count it rather than
      // freezing the bar for the whole scan.
      if (touched != null && touched < started) continue;
    }
    settled.push(testCase);
  }

  const total = (testIds ?? []).length;
  const counts = countScanCases(settled);
  return {
    total,
    done: settled.length,
    percent: total ? Math.round((settled.length / total) * 100) : 0,
    counts: {
      passed: counts.passed,
      failed: counts.failed,
      blocked: counts.blocked,
      other: counts.notExecuted + counts.skipped,
    },
  };
}

/** The scan that currently owns a case (queued or running), newest first. */
export function activeScanForCase(scans, testId) {
  return (
    (scans ?? []).find(
      (scan) =>
        (scan.status === "queued" || scan.status === "running") &&
        (scan.testIds ?? []).includes(testId),
    ) ?? null
  );
}

/**
 * What the scan is called: the operator's label, else - for a scan that ran
 * exactly one case - the case itself, else a case-count fallback.
 *
 * `planCases` is what makes the middle case possible. A column of runs all
 * called "WSTG scan · 1 case" names nothing; the same runs named by the case
 * they executed are readable, and a one-case scan *is* that case.
 */
export function scanName(scan, planCases) {
  const label = (scan?.label ?? "").trim();
  if (label) return label;

  const ids = scan?.testIds ?? [];
  if (ids.length === 1) {
    const testCase = (planCases ?? []).find(
      (entry) => entry.testId === ids[0],
    );
    if (testCase?.title) return `${testCase.testId} — ${testCase.title}`;
    return ids[0];
  }

  return `WSTG scan · ${ids.length} case${ids.length === 1 ? "" : "s"}`;
}

/**
 * The scan's scope as the list shows it: which WSTG categories it covers and
 * how many cases each contributes, e.g. "INFO ×3 · ATHN ×2". Falls back to the
 * raw count when the plan no longer describes the cases.
 */
export function scanScopeLabel(scan, planCases) {
  const ids = scan?.testIds ?? [];
  if (!ids.length) return "no cases";
  const byCategory = new Map();
  let known = 0;
  for (const testId of ids) {
    const testCase = (planCases ?? []).find((entry) => entry.testId === testId);
    if (!testCase) continue;
    known += 1;
    const code = testCase.categoryCode || "OTHER";
    byCategory.set(code, (byCategory.get(code) ?? 0) + 1);
  }
  if (!known) return `${ids.length} case${ids.length === 1 ? "" : "s"}`;
  return [...byCategory.entries()]
    .map(([code, count]) => `${code} ×${count}`)
    .join(" · ");
}

/**
 * Resolve the launcher's choice into the test ids to scan, in plan order so a
 * scan reads the way the plan does. `custom` is intersected with the plan: ids
 * the operator selected before the plan changed can never leak into a launch.
 */
export function resolveScanSelection(planCases, { mode = "not_run", testIds = [] } = {}) {
  const cases = planCases ?? [];
  if (mode === "all") return cases.map((testCase) => testCase.testId);
  if (mode === "custom") {
    const wanted = new Set((testIds ?? []).map((testId) => String(testId).toUpperCase()));
    return cases
      .filter((testCase) => wanted.has(testCase.testId.toUpperCase()))
      .map((testCase) => testCase.testId);
  }
  return cases
    .filter(
      (testCase) =>
        testCase.status === "not_started" || testCase.status === "in_progress",
    )
    .map((testCase) => testCase.testId);
}

// ---------------------------------------------------------------------------
// ACTIVITY GRAPHICS
// Two pure shapes the scan surfaces draw: a timeline of the recent runs and a
// per-day count for the sparkline behind the scan total. Both are pure so the
// duration arithmetic lives in one tested place instead of in two page memos.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tone a scan's status takes wherever it is drawn as a colour. */
const STATUS_TONE = {
  running: "info",
  queued: "mute",
  completed: "success",
  failed: "danger",
  cancelled: "warning",
};

export function scanStatusTone(status) {
  return STATUS_TONE[status] ?? "mute";
}

/** When a scan began, in ms; null when the record carries no usable stamp. */
export function scanStartedAt(scan) {
  const at = new Date(scan?.startedAt ?? scan?.queuedAt ?? scan?.createdAt ?? 0).getTime();
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * How long ago a stamp was, in the shortest honest words: "just now", "4m ago",
 * "2h ago", "3d ago", then the date itself once a week has passed and a reader
 * would be counting backwards.
 *
 * Rounds down, so the number never claims more time has passed than it has, and
 * a future stamp (a clock skew) reads "just now" rather than a negative age.
 */
export function formatAgo(at, now = Date.now()) {
  const stamp = Number(at);
  if (!Number.isFinite(stamp) || stamp <= 0) return "—";

  const seconds = Math.floor((Number(now) - stamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(stamp).toLocaleDateString();
}

/**
 * The recent runs as spans on one shared axis, oldest first so the axis reads
 * left-to-right in time.
 *
 * A finished run without a duration and a live run without a finish still have
 * to be visible, so every span gets a floor of one second and a live run ends
 * at `now`.
 *
 * @returns {{ rows: Array, start: number|null, end: number|null }}
 */
export function scanTimeline(scans, { limit = 8, now = Date.now(), planCases } = {}) {
  const rows = [];
  for (const scan of (scans ?? []).slice(0, Math.max(0, limit))) {
    const start = scanStartedAt(scan);
    if (start === null) continue;
    const finished =
      Number(scan?.durationMs) >= 0 ? start + Number(scan.durationMs) : null;
    const end = Math.max(
      finished ?? (isScanLive(scan) ? now : start + 1000),
      start + 1000,
    );
    rows.push({
      key: scan.runId,
      label: scanName(scan, planCases),
      start,
      end,
      tone: scanStatusTone(scan?.status),
      title: `${scanName(scan, planCases)} · ${scan?.status ?? "unknown"}`,
    });
  }

  rows.reverse();
  if (!rows.length) return { rows: [], start: null, end: null };
  return {
    rows,
    start: Math.min(...rows.map((row) => row.start)),
    end: Math.max(...rows.map((row) => row.end)),
  };
}

/**
 * Scans per day over a window, oldest day first - the series behind the
 * sparkline on the scan total. Counts by the day the scan started.
 */
export function scanActivity(scans, { days = 14, now = Date.now() } = {}) {
  const window = Math.max(1, Math.floor(days));
  const buckets = new Array(window).fill(0);
  const lastDay = new Date(now);
  lastDay.setHours(23, 59, 59, 999);

  for (const scan of scans ?? []) {
    const at = scanStartedAt(scan);
    if (at === null) continue;
    const age = Math.floor((lastDay.getTime() - at) / DAY_MS);
    if (age >= 0 && age < window) buckets[window - 1 - age] += 1;
  }

  return buckets;
}
