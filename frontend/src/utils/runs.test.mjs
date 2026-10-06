import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeRunForCase,
  describeRunResult,
  formatDuration,
  runProgressFromPlan,
} from "./runs.mjs";

test("formatDuration reads like a scan history column", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(3_780_000), "1h 03m");
  assert.equal(formatDuration(undefined), "0s");
});

test("runProgressFromPlan counts settled cases of the run only", () => {
  const planCases = [
    { testId: "WSTG-INFO-02", status: "passed" },
    { testId: "WSTG-INFO-03", status: "failed" },
    { testId: "WSTG-INFO-04", status: "in_progress" },
    { testId: "WSTG-INFO-05", status: "not_started" },
    { testId: "WSTG-INFO-06", status: "passed" }, // not part of this run
  ];
  const progress = runProgressFromPlan(
    ["WSTG-INFO-02", "WSTG-INFO-03", "WSTG-INFO-04", "WSTG-INFO-05"],
    planCases,
  );
  assert.deepEqual(progress, {
    total: 4,
    done: 2,
    percent: 50,
    counts: { passed: 1, failed: 1, blocked: 0, other: 0 },
  });

  assert.equal(runProgressFromPlan(["A"], null).percent, 0);
  assert.equal(runProgressFromPlan([], planCases).percent, 0);
});

test("activeRunForCase returns the newest run that owns the case", () => {
  const runs = [
    { runId: "r2", status: "queued", testIds: ["WSTG-INFO-02"] },
    { runId: "r1", status: "running", testIds: ["WSTG-INFO-02", "WSTG-INFO-03"] },
    { runId: "r0", status: "completed", testIds: ["WSTG-INFO-02"] },
  ];
  assert.equal(activeRunForCase(runs, "WSTG-INFO-02").runId, "r2");
  assert.equal(activeRunForCase(runs, "WSTG-INFO-03").runId, "r1");
  assert.equal(activeRunForCase(runs, "WSTG-INFO-09"), null);
  assert.equal(activeRunForCase(null, "WSTG-INFO-02"), null);
});

test("describeRunResult summarises the finished counts", () => {
  assert.equal(
    describeRunResult({ counts: { passed: 2, failed: 1, blocked: 1, other: 0 } }),
    "2 passed · 1 failed · 1 blocked",
  );
  assert.equal(describeRunResult(null), "");
});
