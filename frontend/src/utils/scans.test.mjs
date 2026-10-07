import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeScanForCase,
  countScanCases,
  formatAgo,
  formatDuration,
  formatStamp,
  isScanLive,
  isUnrunCase,
  resolveScanSelection,
  scanActivity,
  scanCaseStatuses,
  scanCasesByCategory,
  scanFailureGroups,
  scanFindingsByCase,
  scanFindingTotal,
  scanFolderCounts,
  scanMatchesNeedle,
  scanName,
  scanPolicy,
  scanProgress,
  scanRemediations,
  scanScopeLabel,
  scanTimeline,
} from "./scans.mjs";

test("formatDuration reads like a scan history column", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(3_780_000), "1h 03m");
  assert.equal(formatDuration(undefined), "0s");
});

test("formatAgo stays short, never runs backwards, and dates itself after a week", () => {
  const now = new Date(2026, 1, 14, 12, 0, 0).getTime();
  const ago = (seconds) => formatAgo(now - seconds * 1000, now);

  assert.equal(ago(0), "just now");
  assert.equal(ago(44), "just now");
  assert.equal(ago(60), "1m ago");
  assert.equal(ago(59 * 60 + 59), "59m ago");
  assert.equal(ago(60 * 60), "1h ago");
  assert.equal(ago(23 * 3600 + 3599), "23h ago");
  assert.equal(ago(24 * 3600), "1d ago");
  assert.equal(ago(6 * 24 * 3600), "6d ago");

  // A stamp from a skewed clock is not "-2m ago".
  assert.equal(formatAgo(now + 90_000, now), "just now");
  assert.equal(formatAgo(undefined), "—");
  assert.equal(formatAgo(0), "—");
  // Past a week the words stop being shorter than the date.
  assert.equal(formatAgo(new Date(2026, 1, 1).getTime(), now), new Date(2026, 1, 1).toLocaleDateString());
});

test("scanProgress counts the cases this scan settled, not the plan's history", () => {
  const startedAt = new Date("2026-02-14T10:00:00Z");
  const planCases = [
    // Settled by an earlier scan: must not pre-fill this scan's bar.
    { testId: "WSTG-INFO-01", status: "passed", updatedAt: new Date("2026-02-01T09:00:00Z") },
    { testId: "WSTG-INFO-02", status: "passed", updatedAt: new Date("2026-02-14T10:00:05Z") },
    { testId: "WSTG-INFO-03", status: "failed", updatedAt: new Date("2026-02-14T10:00:09Z") },
    { testId: "WSTG-INFO-04", status: "in_progress", updatedAt: new Date("2026-02-14T10:00:10Z") },
    { testId: "WSTG-INFO-05", status: "not_started" },
  ];
  const testIds = planCases.map((one) => one.testId);

  assert.deepEqual(scanProgress(testIds, planCases, { since: startedAt }), {
    total: 5,
    done: 2,
    percent: 40,
    counts: { passed: 1, failed: 1, blocked: 0, other: 0 },
  });

  // Without a start time (a finished scan, or an older plan) every settled case
  // counts, so the readout can never freeze at zero.
  assert.equal(scanProgress(testIds, planCases).done, 3);
  assert.equal(scanProgress(["A"], null).percent, 0);
  assert.equal(scanProgress([], planCases).percent, 0);

  const noTimestamps = [{ testId: "WSTG-INFO-01", status: "passed" }];
  assert.equal(scanProgress(["WSTG-INFO-01"], noTimestamps, { since: startedAt }).done, 1);
});

test("countScanCases gives skipped its own bucket and the rest to notExecuted", () => {
  assert.deepEqual(
    countScanCases([
      { testId: "a", status: "passed" },
      { testId: "b", status: "failed" },
      { testId: "c", status: "blocked" },
      { testId: "d", status: "skipped" },
      { testId: "e", status: "in_progress" },
      { testId: "f", status: "not_started" },
    ]),
    { total: 6, passed: 1, failed: 1, blocked: 1, skipped: 1, notExecuted: 2 },
  );
  assert.equal(countScanCases(null).total, 0);
});

test("scanCaseStatuses prefers the scan's own snapshot over the current plan", () => {
  const scan = {
    testIds: ["WSTG-INFO-01"],
    resultSummary: { perCase: [{ testId: "WSTG-INFO-01", status: "failed" }] },
  };
  const planCases = [{ testId: "WSTG-INFO-01", status: "passed" }];

  assert.deepEqual(scanCaseStatuses(scan, planCases), [
    { testId: "WSTG-INFO-01", status: "failed" },
  ]);
  // A live scan has no snapshot yet: the plan is the live truth.
  assert.deepEqual(scanCaseStatuses({ testIds: ["WSTG-INFO-01"] }, planCases), [
    { testId: "WSTG-INFO-01", status: "passed" },
  ]);
  assert.deepEqual(scanCaseStatuses({ testIds: ["WSTG-INFO-09"] }, planCases), [
    { testId: "WSTG-INFO-09", status: "not_started" },
  ]);
});

test("activeScanForCase returns the newest scan that owns the case", () => {
  const scans = [
    { runId: "r2", status: "queued", testIds: ["WSTG-INFO-02"] },
    { runId: "r1", status: "running", testIds: ["WSTG-INFO-02", "WSTG-INFO-03"] },
    { runId: "r0", status: "completed", testIds: ["WSTG-INFO-02"] },
  ];
  assert.equal(activeScanForCase(scans, "WSTG-INFO-02").runId, "r2");
  assert.equal(activeScanForCase(scans, "WSTG-INFO-03").runId, "r1");
  assert.equal(activeScanForCase(scans, "WSTG-INFO-09"), null);
  assert.equal(activeScanForCase(null, "WSTG-INFO-02"), null);
});

test("scanName prefers the operator's label, then the single case it ran", () => {
  const planCases = [
    { testId: "WSTG-INFO-02", title: "Fingerprint Web Server" },
    { testId: "WSTG-ATHN-01", title: "Credentials over encrypted channel" },
  ];

  assert.equal(
    scanName({ label: "  Juice Shop baseline ", testIds: ["a", "b"] }, planCases),
    "Juice Shop baseline",
  );
  // A one-case scan is that case, not a generic sentence.
  assert.equal(
    scanName({ testIds: ["WSTG-INFO-02"] }, planCases),
    "WSTG-INFO-02 — Fingerprint Web Server",
  );
  // The plan may no longer describe the case: the id is still a name.
  assert.equal(scanName({ testIds: ["WSTG-XXXX-09"] }, planCases), "WSTG-XXXX-09");
  // Without the plan there is no title to borrow - the id still beats a count.
  assert.equal(scanName({ testIds: ["WSTG-INFO-02"] }), "WSTG-INFO-02");
  assert.equal(scanName({ testIds: ["a", "b", "c"] }, planCases), "WSTG scan · 3 cases");
  assert.equal(scanName({}), "WSTG scan · 0 cases");
});

test("scanScopeLabel groups the scan's cases by WSTG category", () => {
  const planCases = [
    { testId: "WSTG-INFO-01", categoryCode: "INFO" },
    { testId: "WSTG-INFO-02", categoryCode: "INFO" },
    { testId: "WSTG-ATHN-01", categoryCode: "ATHN" },
    { testId: "WSTG-INPV-01", categoryCode: "INPV" },
  ];
  assert.equal(
    scanScopeLabel({ testIds: ["WSTG-INFO-01", "WSTG-INFO-02", "WSTG-ATHN-01"] }, planCases),
    "INFO ×2 · ATHN ×1",
  );
  // A scan over cases the plan no longer holds still reads as its own size.
  assert.equal(scanScopeLabel({ testIds: ["WSTG-GONE-01"] }, planCases), "1 case");
  assert.equal(scanScopeLabel({ testIds: [] }, planCases), "no cases");
});

test("resolveScanSelection turns the launcher choice into test ids in plan order", () => {
  const planCases = [
    { testId: "WSTG-INFO-01", status: "passed" },
    { testId: "WSTG-INFO-02", status: "not_started" },
    { testId: "WSTG-INFO-03", status: "in_progress" },
    { testId: "WSTG-ATHN-01", status: "failed" },
  ];

  assert.deepEqual(resolveScanSelection(planCases, { mode: "all" }), [
    "WSTG-INFO-01",
    "WSTG-INFO-02",
    "WSTG-INFO-03",
    "WSTG-ATHN-01",
  ]);
  assert.deepEqual(resolveScanSelection(planCases, { mode: "not_run" }), [
    "WSTG-INFO-02",
    "WSTG-INFO-03",
  ]);
  // Custom keeps plan order and drops ids the plan no longer carries.
  assert.deepEqual(
    resolveScanSelection(planCases, {
      mode: "custom",
      testIds: ["WSTG-ATHN-01", "WSTG-GONE-01", "wstg-info-02"],
    }),
    ["WSTG-INFO-02", "WSTG-ATHN-01"],
  );
  assert.deepEqual(resolveScanSelection(null, { mode: "all" }), []);
  assert.deepEqual(resolveScanSelection(planCases, {}), ["WSTG-INFO-02", "WSTG-INFO-03"]);
});

test("scanTimeline spans the recent runs oldest first and gives every run a width", () => {
  const now = new Date("2026-02-14T12:00:00Z").getTime();
  const scans = [
    // Newest first, the way the API returns them.
    { runId: "r3", status: "running", startedAt: "2026-02-14T11:58:00Z", testIds: ["a"] },
    { runId: "r2", status: "failed", startedAt: "2026-02-14T11:00:00Z", durationMs: 120_000 },
    // A finished scan with no recorded duration must still be visible.
    { runId: "r1", status: "completed", startedAt: "2026-02-14T10:00:00Z", durationMs: null },
    // No usable stamp: dropped rather than drawn at the epoch.
    { runId: "r0", status: "completed" },
  ];

  const { rows, start, end } = scanTimeline(scans, { now });

  assert.deepEqual(
    rows.map((row) => row.key),
    ["r1", "r2", "r3"],
    "oldest first",
  );
  assert.equal(start, new Date("2026-02-14T10:00:00Z").getTime());
  assert.equal(end, now, "a live run ends at now");
  assert.ok(rows[0].end - rows[0].start >= 1000, "a durationless run keeps a sliver");
  assert.equal(rows[2].tone, "info");
  assert.equal(rows[1].tone, "danger");
  assert.equal(scanTimeline([], { now }).rows.length, 0);
  assert.equal(scanTimeline(scans, { now, limit: 2 }).rows.length, 2, "newest two, not oldest two");
});

test("scanActivity counts scans into the day they started, oldest day first", () => {
  // Days are local days, so the fixtures are built in local time: a test that
  // ran in one timezone and passed in another would be measuring nothing.
  const at = (day, hour) => new Date(2026, 1, day, hour, 0, 0).getTime();
  const now = at(14, 20);
  const scans = [
    { runId: "a", startedAt: at(14, 9) },
    { runId: "b", startedAt: at(14, 10) },
    { runId: "c", startedAt: at(12, 10) },
    // Older than the window: ignored, never clamped into the first bucket.
    { runId: "d", startedAt: at(1, 10) },
  ];

  assert.deepEqual(scanActivity(scans, { days: 4, now }), [0, 1, 0, 2]);
  assert.deepEqual(scanActivity(undefined, { days: 3, now }), [0, 0, 0]);
  assert.deepEqual(scanActivity(scans, { days: 1, now }), [2]);
});

test("scanFindingTotal sums the severity histogram the list row reports", () => {
  assert.equal(
    scanFindingTotal({ findingCounts: { critical: 1, high: 2, medium: 0, low: 1, info: 3 } }),
    7,
  );
  assert.equal(scanFindingTotal({ findingCounts: null }), 0);
  // A row that predates the histogram, or a scan with no findings at all.
  assert.equal(scanFindingTotal({}), 0);
  // A partial histogram (missing buckets) still adds up instead of going NaN.
  assert.equal(scanFindingTotal({ findingCounts: { critical: 2 } }), 2);
});

test("scanFindingsByCase buckets a scan's findings by the case that carries them", () => {
  const findings = [
    { testId: "WSTG-INFO-01", severity: "high" },
    { testId: "WSTG-INFO-01", severity: "medium" },
    { testId: "WSTG-INFO-01", severity: "weird" },
    { testId: "WSTG-ATHN-02", severity: "critical" },
    { severity: "high" },
  ];
  const byCase = scanFindingsByCase(findings);
  assert.deepEqual(byCase.get("WSTG-INFO-01"), {
    total: 3,
    counts: { critical: 0, high: 1, medium: 1, low: 0, info: 1 },
  });
  assert.deepEqual(byCase.get("WSTG-ATHN-02").counts.critical, 1);
  // A finding with no case lands nowhere: the strip is per case.
  assert.equal(byCase.size, 2);
  assert.equal(scanFindingsByCase([]).size, 0);
});

test("scanRemediations groups the distinct fixes, worst news first", () => {
  const findings = [
    { testId: "WSTG-ATHN-01", severity: "high", remediation: "Serve over HTTPS." },
    { testId: "WSTG-INFO-09", severity: "critical", remediation: " Enforce authentication. " },
    { testId: "WSTG-INFO-09", severity: "medium", remediation: "Enforce authentication." },
    { testId: "WSTG-INPV-05", severity: "low", remediation: "" },
  ];
  const rows = scanRemediations(findings);
  assert.deepEqual(
    rows.map((row) => [row.action, row.vulns, row.cases, row.worst]),
    [
      ["Enforce authentication.", 2, 1, "critical"],
      ["Serve over HTTPS.", 1, 1, "high"],
      ["No remediation recorded", 1, 1, "low"],
    ],
  );
  assert.deepEqual(scanRemediations([]), []);
});

test("isUnrunCase names the one set every 'scan what is left' surface means", () => {
  assert.equal(isUnrunCase({ status: "not_started" }), true);
  assert.equal(isUnrunCase({ status: "in_progress" }), true);
  assert.equal(isUnrunCase({ status: "passed" }), false);
  assert.equal(isUnrunCase({ status: "skipped" }), false);
  assert.equal(isUnrunCase(undefined), false);
});

test("scanPolicy reads the pre-policy default as unattended", () => {
  assert.equal(scanPolicy({}), "unattended");
  assert.equal(scanPolicy({ policy: undefined }), "unattended");
  assert.equal(scanPolicy({ policy: "unattended" }), "unattended");
  assert.equal(scanPolicy({ policy: "supervised" }), "supervised");
  assert.equal(scanPolicy(null), "unattended");
});

test("scanCasesByCategory counts a scan's cases per WSTG category, in id order", () => {
  const planCases = [
    { testId: "WSTG-INFO-01", categoryCode: "INFO" },
    { testId: "WSTG-INFO-02", categoryCode: "INFO" },
    { testId: "WSTG-ATHN-01", categoryCode: "ATHN" },
  ];
  const byCategory = scanCasesByCategory(planCases, [
    "WSTG-ATHN-01",
    "WSTG-INFO-01",
    "WSTG-INFO-02",
    "WSTG-GONE-01",
  ]);
  assert.deepEqual([...byCategory.entries()], [
    ["ATHN", 1],
    ["INFO", 2],
  ]);
  // A case the plan no longer holds is not counted; unknown codes are still
  // categories.
  assert.deepEqual(
    [...scanCasesByCategory([{ testId: "a" }], ["a"]).entries()],
    [["OTHER", 1]],
  );
  assert.deepEqual([...scanCasesByCategory(null, ["a"]).entries()], []);
});

test("scanFailureGroups counts why the history's scans stopped", () => {
  const scans = [
    { status: "failed", error: "Target refused the connection." },
    { status: "cancelled", error: " Target refused the connection. " },
    { status: "cancelled", error: "Stopped by the operator." },
    { status: "failed", error: "" },
    { status: "failed" },
    { status: "completed" },
    { status: "running" },
  ];
  assert.deepEqual(scanFailureGroups(scans), [
    { reason: "Target refused the connection.", count: 2 },
    { reason: "The run stopped without recording a reason.", count: 2 },
    { reason: "Stopped by the operator.", count: 1 },
  ]);
  // Same count, alphabetical tiebreak; empty history is not an error.
  assert.deepEqual(
    scanFailureGroups([
      { status: "failed", error: "b" },
      { status: "failed", error: "a" },
    ]),
    [
      { reason: "a", count: 1 },
      { reason: "b", count: 1 },
    ],
  );
  assert.deepEqual(scanFailureGroups([]), []);
});

test("scanFolderCounts gives the rail one number per status", () => {
  const counts = scanFolderCounts([
    { status: "running" },
    { status: "completed" },
    { status: "completed" },
    { status: "failed" },
  ]);
  assert.equal(counts.get("running"), 1);
  assert.equal(counts.get("completed"), 2);
  assert.equal(counts.get("failed"), 1);
  assert.equal(counts.get("queued"), undefined);
  assert.equal(scanFolderCounts(null).size, 0);
});

test("scanMatchesNeedle searches name, error, status and case ids", () => {
  const planCases = [{ testId: "WSTG-INFO-02", title: "Fingerprint Web Server" }];
  const scan = {
    status: "failed",
    error: "Target refused the connection.",
    testIds: ["WSTG-INFO-02"],
  };

  assert.equal(scanMatchesNeedle(scan, "", planCases), true);
  assert.equal(scanMatchesNeedle(scan, "  ", planCases), true);
  assert.equal(scanMatchesNeedle(scan, "juice", planCases), false, "no name, no match");
  assert.equal(
    scanMatchesNeedle({ ...scan, label: "Juice Shop baseline" }, "JUICE", planCases),
    true,
  );
  assert.equal(scanMatchesNeedle(scan, "refused", planCases), true);
  assert.equal(scanMatchesNeedle(scan, "failed", planCases), true);
  assert.equal(scanMatchesNeedle(scan, "fingerprint", planCases), true);
  assert.equal(scanMatchesNeedle(null, "x", planCases), false);
});

test("formatStamp prints the short stamp the scan surfaces share", () => {
  const at = new Date(2026, 1, 14, 14, 5).getTime();
  assert.equal(formatStamp(at), new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  assert.equal(formatStamp(null), "—");
  assert.equal(formatStamp(0), "—");
  assert.equal(formatStamp(undefined), "—");
});

test("isScanLive is the one predicate for 'still moving'", () => {
  assert.equal(isScanLive({ status: "queued" }), true);
  assert.equal(isScanLive({ status: "running" }), true);
  assert.equal(isScanLive({ status: "completed" }), false);
  assert.equal(isScanLive({}), false);
  assert.equal(isScanLive(null), false);
});
