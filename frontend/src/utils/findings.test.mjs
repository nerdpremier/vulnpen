import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareBySeverity,
  findingsBySeverity,
  severityRank,
} from "./findings.mjs";

test("severityRank puts critical first and unknown severities last", () => {
  assert.ok(severityRank("critical") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("low"));
  assert.ok(severityRank("low") < severityRank("info"));
  assert.equal(severityRank(""), 5);
  assert.equal(severityRank(undefined), 5);
  assert.equal(severityRank("CRITICAL"), 0);
});

test("findingsBySeverity counts every level and keeps the empty ones in scale", () => {
  const result = findingsBySeverity([
    { severity: "high" },
    { severity: "high" },
    { severity: "info" },
    { severity: "HIGH" },
  ]);

  assert.equal(result.total, 4);
  assert.deepEqual(
    result.levels.map((level) => [level.key, level.count]),
    [
      ["critical", 0],
      ["high", 3],
      ["medium", 0],
      ["low", 0],
      ["info", 1],
    ],
  );
});

test("findingsBySeverity ranks the list without mutating the input", () => {
  const findings = [
    { vulnerabilityId: "a", severity: "low" },
    { vulnerabilityId: "b", severity: "critical" },
    { vulnerabilityId: "c", severity: undefined },
    { vulnerabilityId: "d", severity: "medium" },
  ];

  const { ranked } = findingsBySeverity(findings);

  assert.deepEqual(
    ranked.map((finding) => finding.vulnerabilityId),
    ["b", "d", "a", "c"],
  );
  assert.equal(findings[0].vulnerabilityId, "a");
});

test("findingsBySeverity tolerates an empty or missing list", () => {
  assert.equal(findingsBySeverity(undefined).total, 0);
  assert.equal(findingsBySeverity([]).ranked.length, 0);
});

test("compareBySeverity is stable for equal severities", () => {
  const findings = [{ severity: "high" }, { severity: "high" }];
  assert.equal(compareBySeverity(findings[0], findings[1]), 0);
});
