import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OTHER_GROUP,
  summarise,
  groupCases,
  matchesFilters,
  caseCarriesWork,
} from "./testPlan.mjs";

test("summarise counts every stored status, including in_progress and not_started", () => {
  const cases = [
    { status: "passed" },
    { status: "passed" },
    { status: "failed" },
    { status: "blocked" },
    { status: "in_progress" },
    { status: "skipped" },
    { status: "not_started" },
    { status: "not_started" },
  ];

  const summary = summarise(cases);

  assert.deepEqual(
    {
      passed: summary.passed,
      failed: summary.failed,
      blocked: summary.blocked,
      inProgress: summary.inProgress,
      skipped: summary.skipped,
      notStarted: summary.notStarted,
    },
    {
      passed: 2,
      failed: 1,
      blocked: 1,
      inProgress: 1,
      skipped: 1,
      notStarted: 2,
    },
  );
  assert.equal(summary.total, 8);
  assert.equal(summary.executed, 4);
  assert.equal(summary.percent, 50);
});

test("summarise treats an empty plan as zero, not NaN", () => {
  assert.deepEqual(summarise([]), {
    passed: 0,
    failed: 0,
    blocked: 0,
    inProgress: 0,
    skipped: 0,
    notStarted: 0,
    total: 0,
    executed: 0,
    percent: 0,
  });
});

test("groupCases keeps catalogue order and moves unknown categories to Other", () => {
  const categories = [
    { code: "WSTG-INFO", section: "INFO", name: "Information Gathering" },
    { code: "WSTG-CONF", section: "CONF", name: "Configuration" },
  ];
  const cases = [
    { categoryCode: "WSTG-CONF" },
    { categoryCode: "WSTG-CUSTOM" }, // hand-added by the assistant
    { categoryCode: "WSTG-INFO" },
  ];

  const groups = groupCases(cases, categories);

  assert.deepEqual(
    groups.map((g) => g.key),
    ["WSTG-INFO", "WSTG-CONF", OTHER_GROUP],
  );
  assert.equal(groups[0].cases.length, 1);
  assert.equal(groups[1].cases.length, 1);
  assert.equal(groups[2].cases.length, 1);
  assert.equal(groups[2].name, "Other test cases");
});

test("groupCases drops empty groups", () => {
  const categories = [
    { code: "WSTG-INFO", section: "INFO", name: "Information Gathering" },
    { code: "WSTG-CONF", section: "CONF", name: "Configuration" },
  ];

  const groups = groupCases([{ categoryCode: "WSTG-CONF" }], categories);

  assert.deepEqual(groups.map((g) => g.key), ["WSTG-CONF"]);
});

test("matchesFilters applies the status filter and the needle across fields", () => {
  const testCase = {
    status: "failed",
    testId: "WSTG-INFO-01",
    section: "Information Gathering",
    title: "Search for sensitive information",
    objective: "Find leaked files",
    observations: "robots.txt exposes /admin",
  };

  assert.equal(matchesFilters(testCase, "", "all"), true);
  assert.equal(matchesFilters(testCase, "", "failed"), true);
  assert.equal(matchesFilters(testCase, "", "passed"), false);
  assert.equal(matchesFilters(testCase, "robots", "all"), true);
  assert.equal(matchesFilters(testCase, "ROBOTS", "all"), true);
  assert.equal(matchesFilters(testCase, "cookie", "all"), false);
});

test("caseCarriesWork is true once anything was recorded", () => {
  assert.equal(caseCarriesWork({ status: "not_started" }), false);
  assert.equal(caseCarriesWork({ status: "in_progress" }), true);
  assert.equal(caseCarriesWork({ status: "not_started", observations: "  " }), false);
  assert.equal(caseCarriesWork({ status: "not_started", observations: "found issue" }), true);
  assert.equal(caseCarriesWork({ status: "not_started", notes: "check later" }), true);
  assert.equal(
    caseCarriesWork({ status: "not_started", linkedVulnerabilityIds: ["v1"] }),
    true,
  );
});
