import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildResultSummary,
  decorateRun,
  findingCounts,
  isRunMarker,
  joinRunResults,
  normalizeRunLabel,
  queuePosition,
  runCaseRows,
  runFindings,
  runMarker,
  runPolicy,
  selectRuns,
  sliceRunActivity,
} from "../src/services/web-security/scan-results";

const run = (over: Record<string, unknown> = {}) => ({
  runId: "r1",
  testIds: ["WSTG-INFO-01"],
  label: "",
  status: "queued",
  triggeredBy: "ui",
  queuedAt: new Date(0),
  ...over,
});

test("selectRuns returns the newest scan first without touching the input", () => {
  const runs = [run({ runId: "old" }), run({ runId: "new" })];
  assert.deepEqual(
    selectRuns(runs as any).map((entry) => entry.runId),
    ["new", "old"],
  );
  assert.deepEqual(
    runs.map((entry) => entry.runId),
    ["old", "new"],
  );
});

test("selectRuns filters to the scans that touched one case, case-insensitively", () => {
  const runs = [
    run({ runId: "info", testIds: ["WSTG-INFO-01", "WSTG-INFO-02"] }),
    run({ runId: "authn", testIds: ["WSTG-ATHN-01"] }),
  ];
  assert.deepEqual(
    selectRuns(runs as any, { testId: " wstg-info-01 " }).map((entry) => entry.runId),
    ["info"],
  );
  assert.deepEqual(selectRuns(runs as any, {}).length, 2);
  assert.deepEqual(selectRuns(runs as any, { testId: "WSTG-INFO-09" }), []);
});

test("runPolicy reads the pre-policy default as unattended", () => {
  assert.equal(runPolicy({}), "unattended");
  assert.equal(runPolicy({ policy: undefined }), "unattended");
  assert.equal(runPolicy({ policy: "unattended" }), "unattended");
  assert.equal(runPolicy({ policy: "supervised" }), "supervised");
});

test("normalizeRunLabel trims a label and caps it at the list's width", () => {
  assert.equal(normalizeRunLabel("  Juice Shop baseline "), "Juice Shop baseline");
  assert.equal(normalizeRunLabel(undefined), "");
  assert.equal(normalizeRunLabel("x".repeat(200)).length, 120);
});

test("decorateRun places a record in the queue the way the user counts it", () => {
  const state = { activeRunId: "running-1", queue: ["queued-1", "queued-2"] };

  const running = decorateRun(run({ runId: "running-1", status: "running" }) as any, state);
  assert.equal(running.active, true);
  assert.equal(running.position, undefined);

  // Behind the executing scan: #2, #3.
  assert.equal(decorateRun(run({ runId: "queued-1" }) as any, state).position, 2);
  assert.equal(decorateRun(run({ runId: "queued-2" }) as any, state).position, 3);

  // Nothing executing: the head of the queue is #1.
  assert.equal(
    decorateRun(run({ runId: "queued-1" }) as any, { activeRunId: null, queue: ["queued-1"] })
      .position,
    1,
  );
});

test("decorateRun normalizes the policy so no surface re-derives the default", () => {
  const state = { activeRunId: null, queue: [] };
  assert.equal(
    decorateRun(run({ runId: "r1", status: "completed", policy: "supervised" }) as any, state)
      .policy,
    "supervised",
  );
  // A pre-policy record reads as unattended, once, at the projection.
  assert.equal(
    decorateRun(run({ runId: "r1", status: "completed" }) as any, state).policy,
    "unattended",
  );
  assert.equal(
    decorateRun(run({ runId: "r1", status: "completed", policy: "unattended" }) as any, state)
      .policy,
    "unattended",
  );
});

test("queuePosition is the launch response's and the list's one counting rule", () => {
  const state = { activeRunId: "running-1", queue: ["queued-1", "queued-2"] };
  assert.equal(queuePosition("queued-1", state), 2);
  assert.equal(queuePosition("queued-2", state), 3);
  assert.equal(queuePosition("running-1", state), 1);
});

test("the run marker has one format, and the slice reads exactly that", () => {
  assert.equal(runMarker("abc"), "[WSTG run abc]");
  assert.equal(isRunMarker("[WSTG run abc] Execute ..."), true);
  assert.equal(isRunMarker("[WSTG run abc]"), true);
  assert.equal(isRunMarker("what is the target?"), false);
  assert.equal(isRunMarker(null), false);
});

test("runCaseRows joins the plan and keeps cases the plan no longer holds", () => {
  const planCases = [
    {
      testId: "WSTG-INFO-01",
      title: "Conduct search engine discovery",
      categoryCode: "INFO",
      status: "failed",
      linkedVulnerabilityIds: ["v1"],
    },
  ];
  const rows = runCaseRows(
    ["WSTG-INFO-01", "WSTG-INFO-09"],
    planCases as any,
  );
  assert.deepEqual(rows[0], {
    testId: "WSTG-INFO-01",
    title: "Conduct search engine discovery",
    categoryCode: "INFO",
    status: "failed",
    findingIds: ["v1"],
    inPlan: true,
  });
  assert.equal(rows[1].title, "WSTG-INFO-09");
  assert.equal(rows[1].status, "not_started");
  assert.equal(rows[1].inPlan, false);
  assert.deepEqual(runCaseRows(["WSTG-INFO-01"], null)[0].findingIds, []);
});

test("runFindings lists each finding once, with the case that carries it", () => {
  const cases = runCaseRows(
    ["WSTG-INFO-01", "WSTG-INFO-02"],
    [
      { testId: "WSTG-INFO-01", status: "failed", linkedVulnerabilityIds: ["v1", "v2"] },
      { testId: "WSTG-INFO-02", status: "failed", linkedVulnerabilityIds: ["v1"] },
    ] as any,
  );
  const findings = runFindings(cases, [
    { vulnerabilityId: "v1", title: "Info leak", severity: "medium" },
  ] as any);

  assert.deepEqual(findings, [
    { vulnerabilityId: "v1", title: "Info leak", severity: "medium", testId: "WSTG-INFO-01", cvssScore: undefined, remediation: undefined },
    { vulnerabilityId: "v2", title: "v2", severity: "info", testId: "WSTG-INFO-01", cvssScore: undefined, remediation: undefined },
  ]);
});

test("runFindings carries the CVSS score and the remediation the finding was given", () => {
  const cases = runCaseRows(["WSTG-INFO-01"], [
    { testId: "WSTG-INFO-01", status: "failed", linkedVulnerabilityIds: ["v1"] },
  ] as any);
  const findings = runFindings(cases, [
    {
      vulnerabilityId: "v1",
      title: "TLS misconfigured",
      severity: "high",
      cvss: { score: 7.5 },
      remediation: "Disable TLS 1.0.",
    },
  ] as any);

  assert.deepEqual(findings, [
    {
      vulnerabilityId: "v1",
      title: "TLS misconfigured",
      severity: "high",
      testId: "WSTG-INFO-01",
      cvssScore: 7.5,
      remediation: "Disable TLS 1.0.",
    },
  ]);
});

test("findingCounts histograms the severities a scan produced", () => {
  assert.deepEqual(findingCounts([]), { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  assert.deepEqual(
    findingCounts([
      { vulnerabilityId: "v1", title: "", severity: "critical" },
      { vulnerabilityId: "v2", title: "", severity: "CRITICAL" },
      { vulnerabilityId: "v3", title: "", severity: "high" },
      { vulnerabilityId: "v4", title: "", severity: "medium" },
      { vulnerabilityId: "v5", title: "", severity: "low" },
      { vulnerabilityId: "v6", title: "", severity: "info" },
    ] as any),
    { critical: 2, high: 1, medium: 1, low: 1, info: 1 },
  );
});

test("findingCounts keeps an unknown severity visible instead of dropping it", () => {
  assert.deepEqual(
    findingCounts([
      { vulnerabilityId: "v1", title: "", severity: "" },
      { vulnerabilityId: "v2", title: "", severity: "severe" },
    ] as any),
    { critical: 0, high: 0, medium: 0, low: 0, info: 2 },
  );
});

test("sliceRunActivity cuts one run out of the shared transcript", () => {
  const messages = [
    { id: "0", role: "user", content: "chat question" },
    { id: "1", role: "user", content: "[WSTG run abc] Execute ..." },
    { id: "2", role: "assistant", content: "working" },
    { id: "3", role: "tool", content: "output", toolName: "run_bash" },
    { id: "4", role: "system", content: "internal note" },
    { id: "5", role: "user", content: "[WSTG run def] Execute ..." },
    { id: "6", role: "assistant", content: "next run" },
  ];

  assert.deepEqual(
    sliceRunActivity(messages as any, "abc").map((message) => message.id),
    ["2", "3"],
  );
  assert.deepEqual(
    sliceRunActivity(messages as any, "def").map((message) => message.id),
    ["6"],
  );
  assert.deepEqual(sliceRunActivity(messages as any, "missing"), []);
});

test("buildResultSummary counts settled cases the Nessus way", () => {
  const summary = buildResultSummary(
    ["WSTG-INFO-01", "WSTG-INFO-02", "WSTG-INFO-03"],
    [
      { testId: "WSTG-INFO-01", status: "passed" },
      { testId: "WSTG-INFO-03", status: "blocked" },
    ],
  );
  assert.deepEqual(summary, {
    perCase: [
      { testId: "WSTG-INFO-01", status: "passed" },
      { testId: "WSTG-INFO-02", status: "not_started" },
      { testId: "WSTG-INFO-03", status: "blocked" },
    ],
    counts: { passed: 1, failed: 0, blocked: 1, other: 1 },
  });
});

test("joinRunResults is the one join the list and the detail page read", () => {
  const planCases = [
    {
      testId: "WSTG-INFO-01",
      title: "Conduct search engine discovery",
      categoryCode: "INFO",
      status: "failed",
      linkedVulnerabilityIds: ["v1"],
    },
  ];
  const vulnerabilities = [
    { vulnerabilityId: "v1", title: "Info leak", severity: "medium" },
  ];

  const results = joinRunResults(
    { testIds: ["WSTG-INFO-01", "WSTG-INFO-09"] },
    planCases as any,
    vulnerabilities as any,
  );
  assert.deepEqual(
    results.cases.map((row) => row.testId),
    ["WSTG-INFO-01", "WSTG-INFO-09"],
  );
  assert.deepEqual(
    results.findings.map((row) => row.vulnerabilityId),
    ["v1"],
  );
  assert.deepEqual(results.findingCounts, {
    critical: 0,
    high: 0,
    medium: 1,
    low: 0,
    info: 0,
  });

  // A run with no cases joins to empty results, not to an error.
  assert.deepEqual(joinRunResults({ testIds: [] }, null, null), {
    cases: [],
    findings: [],
    findingCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  });
});
