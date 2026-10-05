import { test } from "node:test";
import assert from "node:assert/strict";
import { promptFactsFromSession } from "../src/services/prompt-facts";

test("a missing session projects to empty engagement facts and zeroed coverage", () => {
  const facts = promptFactsFromSession(null);

  assert.deepEqual(facts.engagement, { target: "", scope: "" });
  assert.equal(facts.webAppSecurity.testPlan, null);
  assert.equal(facts.webAppSecurity.findingCount, 0);
  assert.equal(facts.webAppSecurity.unmappedFindingCount, 0);
  assert.deepEqual(facts.webAppSecurity.owaspBreakdown, []);
});

test("partial engagement context falls back per field, not per session", () => {
  const facts = promptFactsFromSession({
    engagementContext: { target: "https://app.example.com" },
  });

  assert.deepEqual(facts.engagement, {
    target: "https://app.example.com",
    scope: "",
  });
});

test("the OWASP breakdown keeps only categories with findings", () => {
  const facts = promptFactsFromSession({
    vulnerabilities: [{ owaspTop10: "A01:2025" }, { owaspTop10: "a01" }, {}],
  });

  assert.equal(facts.webAppSecurity.findingCount, 3);
  assert.equal(facts.webAppSecurity.unmappedFindingCount, 1);
  // Only A01 has findings; every other catalogue category is filtered out.
  assert.deepEqual(
    facts.webAppSecurity.owaspBreakdown.map((row) => row.id),
    ["A01:2025"],
  );
  assert.equal(facts.webAppSecurity.owaspBreakdown[0].findings, 2);
});

test("the WSTG plan passes through untouched", () => {
  const plan = { version: "4.2", target: "https://app.example.com", cases: [] };
  const facts = promptFactsFromSession({ webAppTestPlan: plan });

  assert.equal(facts.webAppSecurity.testPlan, plan);
});
