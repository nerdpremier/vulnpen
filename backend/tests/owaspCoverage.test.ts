import { test } from "node:test";
import assert from "node:assert/strict";
import { OWASP_TOP10_2025, computeOwaspCoverage } from "../src/knowledge";

test("counts findings per category, normalizing variant forms", () => {
  const coverage = computeOwaspCoverage([
    { owaspTop10: "A01:2025" },
    { owaspTop10: "a01" },
    { owaspTop10: "A1" },
    { owaspTop10: "A05:2025" },
    { owaspTop10: "Injection" },
  ]);
  assert.equal(coverage.total, 5);
  const a01 = coverage.byOwasp.find((row) => row.id === "A01:2025");
  assert.equal(a01?.findings, 3);
  const a05 = coverage.byOwasp.find((row) => row.id === "A05:2025");
  assert.equal(a05?.findings, 2);
});

test("unmapped counts findings without a recognized category, including blank values", () => {
  const coverage = computeOwaspCoverage([
    { owaspTop10: "not-a-category" },
    { owaspTop10: "" },
    {},
    { owaspTop10: "A03:2025" },
  ]);
  assert.equal(coverage.total, 4);
  assert.equal(coverage.unmapped, 3);
  assert.equal(coverage.byOwasp.find((row) => row.id === "A03:2025")?.findings, 1);
});

test("returns one row per catalogue category in order, zero when empty", () => {
  const coverage = computeOwaspCoverage([]);
  assert.equal(coverage.total, 0);
  assert.equal(coverage.unmapped, 0);
  assert.deepEqual(
    coverage.byOwasp.map((row) => row.id),
    OWASP_TOP10_2025.map((category) => category.id),
  );
  assert.ok(coverage.byOwasp.every((row) => row.findings === 0));
  assert.ok(coverage.byOwasp.every((row) => typeof row.title === "string" && row.title.length > 0));
});

test("does not mutate the input findings", () => {
  const findings = [{ owaspTop10: "a10" }];
  computeOwaspCoverage(findings);
  assert.equal(findings[0].owaspTop10, "a10");
});
