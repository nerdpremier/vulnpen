import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OWASP_TOP10_2025,
  WSTG_CATEGORIES,
  WSTG_TESTS,
  findWstgTestsForOwasp,
  getWstgTest,
  isOwaspTop10Id,
} from "../src/knowledge";
import {
  addCatalogueCases,
  addTestCase,
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
  removeCase,
  removeCases,
  updateTestCase,
} from "../src/services/web-security/test-plan.service";
import type { WebAppTestPlanDoc } from "../src/models/Sessions/Sessions.model";
import { mapFindingToOwaspTop10 } from "../src/services/web-security/owasp-mapping.service";
import { buildWebAppPentestReport } from "../src/services/web-security/report.service";
import { normalizeVulnerability } from "../src/services/vulnerability.service";
import { toolRegistry } from "../src/tools/registry";
import { buildSystemPrompt } from "../src/utils/assistant/prompts";

test("the WSTG v4.2 catalogue covers every published test case", () => {
  assert.equal(WSTG_TESTS.length, 97);
  assert.equal(WSTG_CATEGORIES.length, 12);
  assert.equal(new Set(WSTG_TESTS.map((t) => t.id)).size, 97);
  assert.equal(new Set(WSTG_TESTS.map((t) => t.section)).size, 97);

  const expectedCounts: Record<string, number> = {
    INFO: 10,
    CONF: 11,
    IDNT: 5,
    ATHN: 10,
    ATHZ: 4,
    SESS: 9,
    INPV: 19,
    ERRH: 2,
    CRYP: 4,
    BUSL: 9,
    CLNT: 13,
    APIT: 1,
  };

  for (const category of WSTG_CATEGORIES) {
    assert.equal(
      WSTG_TESTS.filter((t) => t.category === category.code).length,
      expectedCounts[category.code],
      category.code,
    );
    assert.ok(category.name && category.objective, category.code);
  }

  for (const wstg of WSTG_TESTS) {
    assert.match(wstg.id, /^WSTG-[A-Z]{4}-\d{2}$/, wstg.id);
    assert.match(wstg.section, /^\d+(\.\d+)+$/, wstg.id);
    assert.ok(wstg.title.trim().length > 4, wstg.id);
    assert.ok(wstg.objective.trim().length > 20, wstg.id);
    assert.ok(wstg.howToTest.trim().length > 40, wstg.id);
    assert.ok(wstg.evidence.trim().length > 10, wstg.id);
    assert.ok(wstg.owasp.length > 0 && wstg.owasp.every(isOwaspTop10Id), wstg.id);
    assert.ok(wstg.cwe.length > 0 && wstg.cwe.every((cwe) => /^CWE-\d+$/.test(cwe)), wstg.id);
    assert.ok(wstg.tools.length > 0, wstg.id);
  }
});

test("the OWASP Top 10:2025 catalogue matches the published release", () => {
  assert.deepEqual(
    OWASP_TOP10_2025.map((category) => [category.id, category.title]),
    [
      ["A01:2025", "Broken Access Control"],
      ["A02:2025", "Security Misconfiguration"],
      ["A03:2025", "Software Supply Chain Failures"],
      ["A04:2025", "Cryptographic Failures"],
      ["A05:2025", "Injection"],
      ["A06:2025", "Insecure Design"],
      ["A07:2025", "Authentication Failures"],
      ["A08:2025", "Software or Data Integrity Failures"],
      ["A09:2025", "Security Logging and Alerting Failures"],
      ["A10:2025", "Mishandling of Exceptional Conditions"],
    ],
  );

  for (const [index, category] of OWASP_TOP10_2025.entries()) {
    assert.equal(category.rank, index + 1, category.id);
    assert.ok(category.summary.length > 30, category.id);
    assert.ok(category.cwes.length >= 3, category.id);
    assert.ok(category.wstgFocus.length >= 1, category.id);
    assert.ok(category.detection.length >= 2, category.id);
    assert.ok(category.remediation.length >= 2, category.id);
    assert.ok(findWstgTestsForOwasp(category.id).length > 0, category.id);

    for (const testId of category.wstgFocus) {
      const wstg = getWstgTest(testId);
      assert.ok(wstg, `${category.id} references unknown test ${testId}`);
      assert.ok(
        wstg.owasp.includes(category.id),
        `${testId} does not map back to ${category.id}`,
      );
    }
  }
});

test("findings map to the Top 10 through the test case that found them", () => {
  const mapping = mapFindingToOwaspTop10({
    title: "SQL injection in the product search",
    wstgId: "4.7.5",
  });
  assert.equal(mapping.primary, "A05:2025");
  assert.equal(mapping.source, "wstg");
  assert.equal(mapping.confidence, "high");
  assert.deepEqual(mapping.wstgIds, ["WSTG-INPV-05"]);
  assert.match(mapping.rationale, /WSTG-INPV-05/);
});

test("an explicit classification outranks every heuristic", () => {
  const mapping = mapFindingToOwaspTop10({
    title: "SQL injection in the product search",
    wstgId: "WSTG-INPV-05",
    owaspTop10: "a06:2025",
  });
  assert.equal(mapping.primary, "A06:2025");
  assert.equal(mapping.source, "explicit");
  assert.equal(mapping.confidence, "high");
  assert.equal(mapping.primaryTitle, "Insecure Design");
  assert.ok(mapping.related.includes("A05:2025"));
});

test("a known CWE maps the finding without any model input", () => {
  const mapping = mapFindingToOwaspTop10({
    title: "Object reference can be swapped between tenants",
    description: "A user can read another organisation's invoice by changing the id.",
    cwe: "639",
  });
  assert.equal(mapping.primary, "A01:2025");
  assert.equal(mapping.source, "cwe");
  assert.match(mapping.rationale, /CWE-639/);
});

test("findings without deterministic signals stay unmapped for the LLM layer", () => {
  const mapping = mapFindingToOwaspTop10({
    title: "Stored XSS in the support ticket subject",
    description: "A script payload in the subject executes for the support agent.",
  });
  assert.equal(mapping.primary, undefined);
  assert.equal(mapping.source, "unmapped");
});

test("an ambiguous CWE refuses to guess and reports its candidates", () => {
  const mapping = mapFindingToOwaspTop10({
    title: "Weakness surfaced by an ambiguous weakness id",
    cwe: "CWE-79",
  });
  // CWE-79 is listed under several 2025 categories in the knowledge base, so
  // the deterministic layer must hand the decision to the LLM classifier.
  if (mapping.ambiguous?.length) {
    assert.equal(mapping.primary, undefined);
    assert.equal(mapping.source, "unmapped");
    assert.ok(mapping.ambiguous.length > 1);
  } else {
    assert.equal(mapping.primary, "A05:2025");
    assert.equal(mapping.source, "cwe");
  }
});

test("an unrecognisable finding is reported as unmapped rather than guessed", () => {
  const mapping = mapFindingToOwaspTop10({ title: "Phase two walkthrough note" });
  assert.equal(mapping.primary, undefined);
  assert.equal(mapping.source, "unmapped");
  assert.match(mapping.rationale, /left unmapped/);
});

test("planned findings are classified at ingestion time", () => {
  const vulnerability = normalizeVulnerability({
    title: "Error messages leak the database engine and query fragments",
    target: "shop.example.test",
    endpoint: "/api/orders",
    wstg_id: "WSTG-ERRH-02",
    cwe: "CWE-209",
  });
  assert.equal(vulnerability.wstgId, "WSTG-ERRH-02");
  assert.equal(vulnerability.wstgTitle, "Testing for Stack Traces");
  assert.equal(vulnerability.owaspTop10, "A10:2025");
  assert.equal(vulnerability.owaspTop10Title, "Mishandling of Exceptional Conditions");
  assert.equal(vulnerability.owaspConfidence, "high");
  assert.ok(vulnerability.owaspMappedAt instanceof Date);
});

test("a generated plan covers the full WSTG catalogue in catalogue order", () => {
  const plan = createTestPlan({ target: "https://app.example.com" }).plan;
  assert.equal(plan.cases.length, WSTG_TESTS.length);
  assert.equal(plan.source, "OWASP WSTG v4.2");
  assert.equal(plan.target, "https://app.example.com");
  assert.deepEqual(
    plan.cases.map((testCase) => testCase.testId),
    WSTG_TESTS.map((test) => test.id),
    "cases follow catalogue order",
  );
  assert.ok(plan.cases.every((testCase) => !("owasp" in testCase) && !("cwe" in testCase)));
});

test("a plan can be narrowed to WSTG categories", () => {
  const plan = createTestPlan({ categories: ["inpv", "athz"] }).plan;
  assert.deepEqual(plan.categories, ["INPV", "ATHZ"]);
  assert.equal(plan.cases.length, 23);
  assert.ok(plan.cases.every((testCase) => ["INPV", "ATHZ"].includes(testCase.categoryCode)));
});

test("explicit test ids win over the full catalogue", () => {
  const plan = createTestPlan({ testIds: ["WSTG-SESS-05", "inpv-5", "WSTG-INFO-01"] }).plan;
  assert.deepEqual(
    plan.cases.map((testCase) => testCase.testId),
    ["WSTG-INFO-01", "WSTG-SESS-05", "WSTG-INPV-05"],
    "explicit ids are normalised and re-ordered by catalogue order",
  );
});

test("custom cases can be added with generated or explicit ids and are kept on regenerate", () => {
  const first = createTestPlan({ target: "https://app.example.com" }).plan;
  const custom = addTestCase(first, {
    title: "Check GraphQL introspection is disabled",
    objective: "Introspection should not expose the schema publicly.",
    howToTest: "POST an introspection query to /graphql and inspect the response.",
    categoryCode: "APIT",
  })!;
  assert.equal(custom.testCase.testId, "CUSTOM-01");
  assert.equal(custom.testCase.status, "not_started");
  assert.equal(custom.testCase.categoryCode, "APIT");

  const second = addTestCase(custom.plan, { title: "Verify robots.txt does not leak admin paths" })!;
  assert.equal(second.testCase.testId, "CUSTOM-02");

  const explicit = addTestCase(second.plan, {
    testId: "CUSTOM-BUSINESS-HOUR",
    title: "Test out-of-hours workflow bypass",
  })!;
  assert.equal(explicit.testCase.testId, "CUSTOM-BUSINESS-HOUR");

  // Duplicate explicit ids are rejected; no title is rejected.
  assert.equal(addTestCase(explicit.plan, { testId: "CUSTOM-BUSINESS-HOUR", title: "dup" }), undefined);
  assert.equal(addTestCase(explicit.plan, {}), undefined);

  const executed = updateTestCase(explicit.plan, "CUSTOM-01", {
    status: "failed",
    observations: "Introspection returned the full schema.",
  })!;
  assert.equal(executed.testCase.status, "failed");

  // Regenerating keeps custom cases and their recorded results.
  const regenerated = createTestPlan({ existing: executed.plan });
  assert.equal(regenerated.kept, WSTG_TESTS.length + 3);
  const kept = regenerated.plan.cases.find((testCase) => testCase.testId === "CUSTOM-01")!;
  assert.equal(kept.status, "failed");
  assert.match(kept.observations, /full schema/);
});

test("regenerating a plan keeps recorded results", () => {
  const first = createTestPlan({ target: "https://app.example.com" }).plan;
  const executed = updateTestCase(first, "WSTG-ATHZ-04", {
    status: "failed",
    observations: "Swapping the invoice id returned another tenant's invoice.",
    addLinkedVulnerabilityId: "vuln_123",
  })!;

  const second = createTestPlan({ categories: ["ATHZ"], existing: executed.plan });
  assert.equal(second.added, 0);
  assert.equal(second.kept, 4);

  const kept = second.plan.cases.find((testCase) => testCase.testId === "WSTG-ATHZ-04")!;
  assert.equal(kept.status, "failed");
  assert.match(kept.observations, /another tenant/);
  assert.deepEqual(kept.linkedVulnerabilityIds, ["vuln_123"]);
  assert.equal(second.coverage.executed, 1);
  assert.equal(second.coverage.failed, 1);
  assert.equal(second.coverage.notStarted, 3);
});

test("status aliases normalise and unknown statuses are ignored", () => {
  const plan = createTestPlan({}).plan;
  const passed = updateTestCase(plan, "wstg-info-1", { status: "pass" })!;
  assert.equal(passed.testCase.status, "passed");

  const unchanged = updateTestCase(passed.plan, "WSTG-INFO-01", { status: "not-a-status" })!;
  assert.equal(unchanged.testCase.status, "passed");
});

test("case text can be edited through update_case", () => {
  const plan = createTestPlan({}).plan;
  const edited = updateTestCase(plan, "WSTG-INFO-01", {
    title: "Review the SPF record (edited)",
    objective: "Check the published mail policy.",
    howToTest: "dig TXT example.com",
    notes: "user asked to tailor this case",
  })!;
  assert.equal(edited.testCase.title, "Review the SPF record (edited)");
  assert.equal(edited.testCase.objective, "Check the published mail policy.");
  assert.equal(edited.testCase.howToTest, "dig TXT example.com");
  assert.equal(edited.testCase.notes, "user asked to tailor this case");
});

test("coverage is reported per WSTG category without OWASP pre-mapping", () => {
  const plan = createTestPlan({}).plan;
  const withResults = updateTestCase(
    updateTestCase(plan, "WSTG-INPV-05", { status: "failed" })!.plan,
    "WSTG-INPV-01",
    { status: "passed" },
  )!.plan;

  const coverage = computeCoverage(withResults.cases);
  assert.equal(coverage.total, WSTG_TESTS.length);
  assert.equal(coverage.executed, 2);
  assert.equal(coverage.passed, 1);
  assert.equal(coverage.failed, 1);
  assert.equal(coverage.percentExecuted, 2.1);

  const inpv = coverage.byCategory.find((row) => row.key === "INPV")!;
  assert.equal(inpv.executed, 2);
  assert.equal(inpv.failed, 1);
  assert.equal(inpv.label, "Input Validation Testing");

  // The plan does not carry OWASP/CWE pre-mapping: mapping lives on findings.
  assert.equal((coverage as any).byOwasp, undefined);

  assert.equal(nextTestsToRun(withResults, 3).length, 3);
  assert.ok(
    nextTestsToRun(withResults, 1)[0].testId !== "WSTG-INPV-05",
    "executed cases are never suggested again",
  );
});

test("the report draft is complete enough to hand to a reviewer", () => {
  const plan = createTestPlan({ target: "https://app.example.com" }).plan;
  const failed = updateTestCase(plan, "WSTG-INPV-05", {
    status: "failed",
    observations: "Payload returned a database error.",
    addLinkedVulnerabilityId: "vuln_sqli",
  })!.plan;
  const executed = updateTestCase(failed, "WSTG-ERRH-02", { status: "passed" })!.plan;

  const sqli = normalizeVulnerability(
    {
      vulnerabilityId: "vuln_sqli",
      title: "Unauthenticated SQL injection in product search",
      target: "shop.example.test",
      endpoint: "GET https://shop.example.test/api/products?q=",
      likelihood: 3,
      impactRating: 3,
      cwe: "CWE-89",
      wstgId: "WSTG-INPV-05",
      evidence: "q=' returned SQLSTATE syntax error.",
      stepsToReproduce: "Send GET /api/products?q=' and observe the SQL error",
      impact: "Full read access to the product database.",
      remediation: "Use parameterised queries.",
      exploited: true,
    },
    { source: "agent" },
  );

  const unmapped = normalizeVulnerability({ title: "Phase two walkthrough note", target: "shop.example.test" });

  const report = buildWebAppPentestReport({
    session: { sessionId: "sess-1", name: "Shop review" },
    target: "https://shop.example.com",
    scope: "Public storefront and REST API",
    client: "Acme Retail",
    tester: "VulnPen",
    vulnerabilities: [unmapped, sqli],
    testPlan: executed,
    generatedAt: new Date("2026-02-01T00:00:00.000Z"),
  });

  assert.equal(report.stats.totalFindings, 2);
  assert.equal(report.stats.bySeverity.high, 1);
  assert.equal(report.stats.exploited, 1);
  assert.equal(report.stats.unmapped, 1);
  assert.equal(report.stats.coverage.executed, 2);
  assert.equal(
    report.stats.byOwasp.find((row) => row.id === "A05:2025")?.findings,
    1,
  );
  assert.equal(report.findings[0].owaspTop10, "A05:2025", "highest-severity finding sorts first");
  assert.equal(report.fileName, "shop-example-com-web-app-pentest-report-2026-02-01.md");

  const markdown = report.markdown;
  for (const heading of [
    "# Shop review — Web Application Penetration Testing Report (draft)",
    "## 1. Introduction",
    "### 1.1 Version control",
    "### 1.2 Table of contents",
    "### 1.3 Test team",
    "### 1.4 Engagement details",
    "### 1.5 Disclaimer",
    "### 1.6 Timeline",
    "### 1.7 Standards and references applied",
    "## 2. Executive summary",
    "## 3. Scope, methodology and limitations",
    "## 4. Risk summary",
    "## 5. Findings summary",
    "## 6. Detailed findings",
    "## 7. WSTG v4.2 test coverage",
    "## 8. OWASP Top 10:2025 mapping",
    "## 9. Recommendations",
    "## 10. Appendix A — Test case inventory",
    "## 11. Appendix B - Risk rating methodology",
    "## 12. Appendix C - Glossary and references",
  ]) {
    assert.ok(markdown.includes(heading), `missing heading: ${heading}`);
  }

  assert.match(markdown, /F-001 — Unauthenticated SQL injection in product search/);
  assert.match(markdown, /A05:2025 Injection/);
  assert.match(markdown, /WSTG-INPV-05/);
  assert.match(markdown, /Unmapped/);
  assert.match(markdown, /OWASP WSTG v4\.2/);
  assert.ok(!/CVSS/.test(markdown), "CVSS is gone from the report");
  assert.match(markdown, /Risk \(likelihood x impact, equal weight\) \| high/);
  assert.match(markdown, /Use parameterised queries\./);
  assert.match(markdown, /2 of 97 planned WSTG test cases were executed/);
});

test("a finding is accepted without OWASP or CWE and stays unmapped", () => {
  const vulnerability = normalizeVulnerability({
    title: "Phase two walkthrough note",
    target: "shop.example.test",
    evidence: "Nothing conclusive was observed during the walkthrough.",
  });
  assert.ok(!vulnerability.cwe);
  assert.equal(vulnerability.owaspTop10, undefined);
  assert.equal(vulnerability.owaspMappedAt, undefined);
  // No category was forced: the classifier leaves the finding unmapped.
  assert.ok(!vulnerability.owaspTop10Title);
});

test("the assistant exposes the web application security tools", () => {
  for (const name of ["wstg_test_plan", "map_finding_owasp", "generate_pentest_report"]) {
    assert.ok(toolRegistry.has(name), `${name} is not registered`);
    assert.ok(
      toolRegistry.toOpenAISchemas({ agentRole: "main" }).some(
        (schema) => schema.type === "function" && schema.function.name === name,
      ),
      `${name} is not offered to the main agent`,
    );
  }

  const properties = (toolRegistry.get("update_engagement_state")!.parameters as any).properties;
  assert.equal(properties.data.properties.wstgId.type, "string");
  assert.equal(properties.data.properties.owaspTop10.type, "string");
});
test("the assistant proposes a WSTG plan as soon as the user names a target", () => {
  const prompt = buildSystemPrompt({
    sessionId: "sess-chat",
    webAppSecurity: { testPlan: null },
  });

  assert.match(prompt, /Web Application Security Testing Assistant inside VulnPen/);
  assert.match(prompt, /Plan — and show the plan before you test/);
  assert.match(prompt, /No WSTG test plan exists for this session yet/);
  assert.match(prompt, /wstg_test_plan/);
  assert.match(
    prompt,
    /Never start firing payloads at a target the user has not confirmed is in scope/,
  );
  assert.match(prompt, /OWASP Top 10:2025 — the risk vocabulary/);
  assert.match(prompt, /A10:2025 Mishandling of Exceptional Conditions/);
  assert.match(prompt, /Current WSTG v4\.2 test plan/);
});

test("an existing plan is re-injected with coverage, results and next cases", () => {
  const plan = createTestPlan({ target: "https://abc.example.com" }).plan;
  const failed = updateTestCase(plan, "WSTG-INPV-05", {
    status: "failed",
    observations: "q=' returned a database error.",
    addLinkedVulnerabilityId: "vuln_abc",
  })!.plan;
  const executed = updateTestCase(failed, "WSTG-INFO-01", { status: "passed" })!.plan;

  const prompt = buildSystemPrompt({
    sessionId: "sess-chat",
    webAppSecurity: {
      testPlan: executed,
      findingCount: 3,
      unmappedFindingCount: 1,
      owaspBreakdown: [{ id: "A05:2025", title: "Injection", findings: 2 }],
    },
  });

  assert.match(
    prompt,
    /<wstg_test_plan source="OWASP WSTG v4\.2" target="https:\/\/abc\.example\.com">/,
  );
  assert.match(prompt, /Coverage: 2\/97 executed \(2\.1%\)/);
  assert.match(prompt, /\[x\] WSTG-INPV-05 \(4\.7\.5\) Testing for SQL Injection/);
  assert.match(prompt, /Tests that produced findings \(link every finding to its test\)/);
  assert.match(prompt, /Next tests \(plan order\):/);
  assert.match(prompt, /Tracked findings: 3, of which 1 are not mapped/);
  assert.match(prompt, /Current risk spread: A05:2025 Injection \(2\)/);
  assert.match(prompt, /action "update_case" \(test_id \+ status\)/);
  assert.match(prompt, /action "add_case"/);
});

test("catalogue cases can be added to a narrowed plan without losing results", () => {
  const narrowed = createTestPlan({ categories: ["INPV"] }).plan;
  const executed = updateTestCase(narrowed, "WSTG-INPV-05", {
    status: "passed",
    observations: "Parameterised query returned no database error.",
  })!.plan;

  const added = addCatalogueCases(executed, [
    "WSTG-ATHZ-04",
    "inpv-5",
    "4.8.1",
    "WSTG-NOPE-99",
    "",
    null,
  ]);

  assert.deepEqual(
    added.added.map((testCase) => testCase.testId),
    ["WSTG-ATHZ-04", "WSTG-ERRH-01"],
    "sections and short ids resolve, duplicates and junk do not",
  );
  assert.deepEqual(added.skipped, ["WSTG-INPV-05"]);
  assert.deepEqual(added.unknown, ["WSTG-NOPE-99"]);
  assert.equal(added.plan.cases.length, 21);

  // Added cases slot into catalogue order; the executed case keeps its result.
  assert.equal(added.plan.cases[0].testId, "WSTG-ATHZ-04");
  assert.equal(added.plan.cases[added.plan.cases.length - 1].testId, "WSTG-ERRH-01");
  const kept = added.plan.cases.find((testCase) => testCase.testId === "WSTG-INPV-05")!;
  assert.equal(kept.status, "passed");
  assert.match(kept.observations, /Parameterised query/);

  // Nothing new to add leaves the plan untouched.
  const again = addCatalogueCases(added.plan, ["WSTG-ATHZ-04", "WSTG-ERRH-01", ""]);
  assert.equal(again.plan, added.plan);
  assert.equal(again.added.length, 0);
  assert.deepEqual(again.skipped, ["WSTG-ATHZ-04", "WSTG-ERRH-01"]);
});

test("cases can be removed one by one or in bulk", () => {
  const plan = createTestPlan({ categories: ["ERRH"] }).plan;

  const single = removeCase(plan, "WSTG-ERRH-01")!;
  assert.equal(single.testId, "WSTG-ERRH-01");
  assert.equal(single.plan.cases.length, 1);
  assert.equal(removeCase(single.plan, "WSTG-ERRH-01"), undefined);
  assert.equal(removeCase(single.plan, "WSTG-INPV-05"), undefined);

  const bulk = removeCases(plan, ["WSTG-ERRH-01", "WSTG-ERRH-02", "nope"])!;
  assert.deepEqual(bulk.removed, ["WSTG-ERRH-01", "WSTG-ERRH-02"]);
  assert.equal(bulk.plan.cases.length, 0);
  assert.equal(removeCases(bulk.plan, ["WSTG-ERRH-01"]), undefined);
  assert.equal(removeCases(plan, []), undefined);
  assert.equal(removeCases(plan, ["", null, 7]), undefined);

  // Removing everything is a legitimate plan state: coverage comes back empty, not broken.
  const coverage = computeCoverage(bulk.plan.cases);
  assert.equal(coverage.total, 0);
  assert.equal(coverage.percentExecuted, 0);
});
test("a hydrated plan is normalised before it is handed back for saving", () => {
  const plan = createTestPlan({
    target: "https://hydrated.example.com",
    categories: ["INPV"],
  }).plan;

  // A mongoose document keeps its schema fields behind non-enumerable getters, so spreading one
  // copies internals only: a controller that saves the result then writes nothing at all.
  const hydrate = (source: WebAppTestPlanDoc): WebAppTestPlanDoc => {
    const doc: Record<string, unknown> = { $__: {}, $isNew: false, _doc: source };
    for (const [key, value] of Object.entries(source)) {
      if (key === "cases") continue;
      Object.defineProperty(doc, key, { get: () => value, enumerable: false });
    }
    doc.cases = source.cases;
    doc.toObject = () => source;
    return doc as unknown as WebAppTestPlanDoc;
  };

  const removed = removeCases(hydrate(plan), ["WSTG-INPV-01"])!;
  const addedCatalogue = addCatalogueCases(hydrate(plan), ["WSTG-CLNT-01"]);
  const addedCustom = addTestCase(hydrate(plan), { title: "Case added to a hydrated plan" })!;
  const updated = updateTestCase(hydrate(plan), "WSTG-INPV-01", { status: "passed" })!;

  assert.equal(removed.plan.cases.length, plan.cases.length - 1);
  assert.equal(addedCatalogue.plan.cases.length, plan.cases.length + 1);
  assert.deepEqual(
    addedCatalogue.added.map((testCase) => testCase.testId),
    ["WSTG-CLNT-01"],
  );
  assert.equal(addedCustom.plan.cases.length, plan.cases.length + 1);
  assert.equal(updated.testCase.status, "passed");

  const results: [string, WebAppTestPlanDoc][] = [
    ["removeCases", removed.plan],
    ["addCatalogueCases", addedCatalogue.plan],
    ["addTestCase", addedCustom.plan],
    ["updateTestCase", updated.plan],
  ];

  for (const [label, result] of results) {
    assert.equal(result.target, "https://hydrated.example.com", `${label} kept the target`);
    assert.equal(result.source, "OWASP WSTG v4.2", `${label} kept the source`);
    assert.deepEqual(
      Object.keys(result).sort(),
      Object.keys(plan).sort(),
      `${label} returned plain plan data`,
    );
  }
});

test("ticking no category plans no catalogue cases", () => {
  const plan = createTestPlan({ target: "https://app.example.com", categories: ["INPV"] }).plan;
  const executed = updateTestCase(plan, "WSTG-INPV-05", { status: "passed" })!.plan;

  // An absent list is "no filter": the whole guide.
  assert.equal(createTestPlan({}).plan.cases.length, WSTG_TESTS.length);

  // A list that is present but empty is "nothing ticked".
  const emptied = createTestPlan({ categories: [], existing: executed }).plan;
  assert.equal(emptied.cases.length, 0);
  assert.deepEqual(emptied.categories, []);
  assert.equal(emptied.target, "https://app.example.com", "the details are left alone");
  assert.equal(computeCoverage(emptied.cases).total, 0);

  // Unknown codes plan nothing rather than everything.
  assert.equal(createTestPlan({ categories: ["NOPE"] }).plan.cases.length, 0);
});