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
  TEST_PLAN_DEPTHS,
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
  updateTestCase,
} from "../src/services/web-security/test-plan.service";
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

test("keyword classification is used when no CWE or test case is available", () => {
  const mapping = mapFindingToOwaspTop10({
    title: "Stored XSS in the support ticket subject",
    description: "A script payload in the subject executes for the support agent.",
  });
  assert.equal(mapping.primary, "A05:2025");
  assert.equal(mapping.source, "keyword");
  assert.ok(mapping.wstgIds.includes("WSTG-INPV-02"));
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

test("depth tiers are cumulative and cover the whole guide at full depth", () => {
  const counts = TEST_PLAN_DEPTHS.map((depth) => depth.testCount);
  assert.deepEqual(counts, [24, 56, 90, 97]);

  for (const depth of TEST_PLAN_DEPTHS) {
    const plan = createTestPlan({ depth: depth.id, target: "https://app.example.com" }).plan;
    assert.equal(plan.cases.length, depth.testCount, depth.id);
    assert.equal(plan.source, "OWASP WSTG v4.2");
    assert.equal(plan.target, "https://app.example.com");
  }
});

test("a plan can be narrowed to WSTG categories", () => {
  const plan = createTestPlan({ depth: "full", categories: ["inpv", "athz"] }).plan;
  assert.deepEqual(plan.categories, ["INPV", "ATHZ"]);
  assert.equal(plan.cases.length, 23);
  assert.ok(plan.cases.every((testCase) => ["INPV", "ATHZ"].includes(testCase.categoryCode)));
});

test("regenerating a plan keeps recorded results", () => {
  const first = createTestPlan({ depth: "smoke", target: "https://app.example.com" }).plan;
  const executed = updateTestCase(first, "WSTG-ATHZ-04", {
    status: "failed",
    observations: "Swapping the invoice id returned another tenant's invoice.",
    addLinkedVulnerabilityId: "vuln_123",
  })!;

  const second = createTestPlan({ depth: "standard", existing: executed.plan });
  assert.equal(second.added, 32);
  assert.equal(second.kept, 24);

  const kept = second.plan.cases.find((testCase) => testCase.testId === "WSTG-ATHZ-04")!;
  assert.equal(kept.status, "failed");
  assert.match(kept.observations, /another tenant/);
  assert.deepEqual(kept.linkedVulnerabilityIds, ["vuln_123"]);
  assert.equal(second.coverage.executed, 1);
  assert.equal(second.coverage.failed, 1);
  assert.equal(second.coverage.notStarted, 55);
});

test("status aliases normalise and unknown statuses are ignored", () => {
  const plan = createTestPlan({ depth: "smoke" }).plan;
  const passed = updateTestCase(plan, "wstg-info-1", { status: "pass" })!;
  assert.equal(passed.testCase.status, "passed");

  const unchanged = updateTestCase(passed.plan, "WSTG-INFO-01", { status: "not-a-status" })!;
  assert.equal(unchanged.testCase.status, "passed");
});

test("coverage is reported per WSTG category and per Top 10 category", () => {
  const plan = createTestPlan({ depth: "smoke" }).plan;
  const withResults = updateTestCase(
    updateTestCase(plan, "WSTG-INPV-05", { status: "failed" })!.plan,
    "WSTG-INPV-01",
    { status: "passed" },
  )!.plan;

  const coverage = computeCoverage(withResults.cases);
  assert.equal(coverage.total, 24);
  assert.equal(coverage.executed, 2);
  assert.equal(coverage.passed, 1);
  assert.equal(coverage.failed, 1);
  assert.equal(coverage.percentExecuted, 8.3);

  const inpv = coverage.byCategory.find((row) => row.key === "INPV")!;
  assert.equal(inpv.executed, 2);
  assert.equal(inpv.failed, 1);
  assert.equal(inpv.label, "Input Validation Testing");

  const injection = coverage.byOwasp.find((row) => row.key === "A05:2025")!;
  assert.equal(injection.executed, 2);
  assert.equal(injection.failed, 1);

  assert.equal(nextTestsToRun(withResults, 3).length, 3);
  assert.ok(
    nextTestsToRun(withResults, 1)[0].testId !== "WSTG-INPV-05",
    "executed cases are never suggested again",
  );
});

test("the report draft is complete enough to hand to a reviewer", () => {
  const plan = createTestPlan({ depth: "smoke", target: "https://app.example.com" }).plan;
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
      cvss: "9.1",
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
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
    tester: "BugBase",
    vulnerabilities: [unmapped, sqli],
    testPlan: executed,
    generatedAt: new Date("2026-02-01T00:00:00.000Z"),
  });

  assert.equal(report.stats.totalFindings, 2);
  assert.equal(report.stats.bySeverity.critical, 1);
  assert.equal(report.stats.exploited, 1);
  assert.equal(report.stats.unmapped, 1);
  assert.equal(report.stats.coverage.executed, 2);
  assert.equal(
    report.stats.byOwasp.find((row) => row.id === "A05:2025")?.findings,
    1,
  );
  assert.equal(report.findings[0].owaspTop10, "A05:2025", "critical finding sorts first");
  assert.equal(report.fileName, "shop-example-com-web-app-pentest-report-2026-02-01.md");

  const markdown = report.markdown;
  for (const heading of [
    "# Shop review — Web Application Penetration Testing Report (draft)",
    "## 1. Document control",
    "## 2. Executive summary",
    "## 3. Scope and methodology",
    "## 4. Risk summary",
    "## 5. Findings summary",
    "## 6. Detailed findings",
    "## 7. WSTG v4.2 test coverage",
    "## 8. OWASP Top 10:2025 mapping",
    "## 9. Recommendations",
    "## 10. Appendix A — Test case inventory",
    "## 11. Appendix B — Glossary and references",
  ]) {
    assert.ok(markdown.includes(heading), `missing heading: ${heading}`);
  }

  assert.match(markdown, /F-001 — Unauthenticated SQL injection in product search/);
  assert.match(markdown, /A05:2025 Injection/);
  assert.match(markdown, /WSTG-INPV-05/);
  assert.match(markdown, /Unmapped/);
  assert.match(markdown, /OWASP WSTG v4\.2/);
  assert.match(markdown, /CVSS 9\.1/);
  assert.match(markdown, /Use parameterised queries\./);
  assert.match(markdown, /2 of 24 planned WSTG test cases were executed/);
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
  assert.match(prompt, /- A10:2025 Mishandling of Exceptional Conditions/);
  assert.match(prompt, /Current WSTG v4\.2 test plan/);
});

test("an existing plan is re-injected with coverage, results and next cases", () => {
  const plan = createTestPlan({ depth: "smoke", target: "https://abc.example.com" }).plan;
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
    /<wstg_test_plan source="OWASP WSTG v4\.2" depth="smoke" target="https:\/\/abc\.example\.com">/,
  );
  assert.match(prompt, /Coverage: 2\/24 executed \(8\.3%\)/);
  assert.match(prompt, /\[x\] WSTG-INPV-05 \(4\.7\.5\) Testing for SQL Injection — A05:2025/);
  assert.match(prompt, /Tests that produced findings \(link every finding to its test\)/);
  assert.match(prompt, /Next tests by priority:/);
  assert.match(prompt, /Tracked findings: 3, of which 1 are not mapped/);
  assert.match(prompt, /Current risk spread: A05:2025 Injection \(2\)/);
  assert.match(prompt, /action "update_case" \(test_id \+ status\)/);
});
