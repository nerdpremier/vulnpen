import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OWASP_TOP10_2025,
  wstgRiskRating,
} from "../src/knowledge";
import { toolRegistry } from "../src/tools/registry";
import {
  OWASP_TOP10_2025_CWE_PROVENANCE,
  WSTG_OWASP_CROSSWALK_PROVENANCE,
} from "../src/knowledge/provenance";
import { mapFindingToOwaspTop10 } from "../src/services/web-security/owasp-mapping.service";
import {
  buildWebAppPentestReport,
  maskSensitive,
} from "../src/services/web-security/report.service";
import { normalizeVulnerability } from "../src/services/vulnerability.service";

// Official per-category CWE counts from the OWASP Top 10:2025 "List of Mapped
// CWEs" sections (transcribed 2026-10-02, see knowledge/provenance.ts). These
// numbers are the conformance guard: if the catalog drifts from owasp.org, the
// test fails instead of the mapping silently going wrong.
const OFFICIAL_CWE_COUNTS: Record<string, number> = {
  "A01:2025": 40,
  "A02:2025": 16,
  "A03:2025": 6,
  "A04:2025": 32,
  "A05:2025": 37,
  "A06:2025": 39,
  "A07:2025": 36,
  "A08:2025": 14,
  "A09:2025": 5,
  "A10:2025": 24,
};

test("the OWASP Top 10:2025 CWE lists match the published counts", () => {
  for (const category of OWASP_TOP10_2025) {
    const expected = OFFICIAL_CWE_COUNTS[category.id];
    assert.ok(expected, category.id + " has no reference count");
    assert.equal(category.cwes.length, expected, category.id + " CWE count");
    assert.equal(new Set(category.cwes).size, category.cwes.length, category.id + " duplicates a CWE");
    assert.ok(category.cwes.every((cwe) => /^CWE-\d+$/.test(cwe)), category.id + " has a malformed CWE");
  }
  const total = OWASP_TOP10_2025.reduce((sum, category) => sum + category.cwes.length, 0);
  assert.equal(total, 249);
});

test("the catalog carries the official CWEs, not the pre-audit approximations", () => {
  const byId = new Map(OWASP_TOP10_2025.map((category) => [category.id, category]));
  const a01 = byId.get("A01:2025")!;
  for (const cwe of ["CWE-200", "CWE-201", "CWE-352", "CWE-601", "CWE-918", "CWE-1275"]) {
    assert.ok(a01.cwes.includes(cwe), "A01 is missing " + cwe);
  }
  const a03 = byId.get("A03:2025")!;
  assert.deepEqual(a03.cwes, ["CWE-447", "CWE-1035", "CWE-1104", "CWE-1329", "CWE-1357", "CWE-1395"]);
  // CWE-937 was in the 2021 Vulnerable Components list; it is not in 2025.
  assert.ok(!OWASP_TOP10_2025.some((category) => category.cwes.includes("CWE-937")));
});

test("the reference data records its provenance", () => {
  assert.equal(OWASP_TOP10_2025_CWE_PROVENANCE.kind, "official");
  assert.match(OWASP_TOP10_2025_CWE_PROVENANCE.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(WSTG_OWASP_CROSSWALK_PROVENANCE.kind, "curated");
  assert.ok(WSTG_OWASP_CROSSWALK_PROVENANCE.basis.includes("OWASP does not publish"));
});

test("mapping states an honest provenance for every source", () => {
  assert.equal(mapFindingToOwaspTop10({ owaspTop10: "A01:2025" }).provenance, "tester");

  const wstg = mapFindingToOwaspTop10({ wstgId: "WSTG-INPV-05" });
  assert.equal(wstg.provenance, "curated");
  assert.ok(
    !/OWASP Top 10:2025 mapping of WSTG/.test(wstg.rationale),
    "the rationale must not claim OWASP authorship of the crosswalk",
  );

  assert.equal(mapFindingToOwaspTop10({ cwe: "CWE-918" }).provenance, "official");
});

test("evidence is masked in the report", () => {
  assert.match(maskSensitive("password=Hunter2"), /password=\[REDACTED\]/i);
  assert.match(maskSensitive("Authorization: Bearer abc.def.ghi"), /Bearer \[REDACTED\]/i);
  assert.match(maskSensitive("cookie=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefg"), /\[REDACTED-JWT\]/);
  assert.equal(maskSensitive("ordinary text"), "ordinary text");
});

test("the report follows the WSTG Reporting structure and cites its sources", () => {
  const vulnerability = normalizeVulnerability({
    title: "SQL injection in product search",
    host: "shop.example.test",
    endpoint: "GET /api/products?q=",
    likelihood: 3,
    impactRating: 3,
    cwe: "CWE-89",
    wstgId: "WSTG-INPV-05",
    description: "The q parameter is concatenated into a SQL query.",
    evidence: "password=Hunter2 returned a SQLSTATE syntax error",
    stepsToReproduce: "1. Send GET /api/products?q=" + String.fromCharCode(39) + "\n2. Observe the error",
    contextSummary: "The public search concatenates input.",
    impact: "Full read of the product database.",
    remediation: "Use parameterised queries.",
    exploited: true,
  });
  assert.equal(vulnerability.severity, "high", "3x3 on the matrix is high");

  const report = buildWebAppPentestReport({
    session: { sessionId: "s1", name: "Example engagement", createdAt: new Date("2026-01-01T00:00:00Z") },
    target: "https://shop.example.test",
    tester: "A. Tester",
    vulnerabilities: [vulnerability],
  });

  const headings = [
    "## 1. Introduction",
    "### 1.1 Version control",
    "### 1.2 Table of contents",
    "### 1.3 Test team",
    "### 1.4 Engagement details",
    "### 1.5 Disclaimer",
    "### 1.6 Timeline",
    "### 1.7 Standards and references applied",
    "## 2. Executive summary",
    "## 11. Appendix B - Risk rating methodology",
    "## 12. Appendix C - Glossary and references",
  ];
  for (const heading of headings) {
    assert.ok(report.markdown.includes(heading), "missing " + heading);
  }

  assert.ok(report.markdown.includes("WSTG Reporting guidance"), "WSTG Reporting is cited");
  assert.ok(report.markdown.includes("OWASP Risk Rating Methodology"), "risk rating is cited");
  assert.ok(!report.markdown.includes("CVSS"), "CVSS is not used anywhere in the report");
  assert.ok(!report.markdown.includes("Hunter2"), "the secret is masked in the report");
  assert.ok(/password=\[REDACTED\]/i.test(report.markdown), "the masked secret is present");
  assert.ok(report.findings[0].owaspProvenance, "the finding records a mapping provenance");
  assert.ok(report.markdown.includes("| Likelihood | high (3/3) |"), "likelihood factor is reported");
  assert.ok(report.markdown.includes("equal weight"), "the report states the factors carry equal weight");
});

test("business risk follows the documented risk matrix bands", () => {
  assert.equal(wstgRiskRating(3, 3), "high");
  assert.equal(wstgRiskRating(3, 2), "medium");
  assert.equal(wstgRiskRating(3, 1), "low");
  assert.equal(wstgRiskRating(2, 3), "medium");
  assert.equal(wstgRiskRating(2, 2), "medium");
  assert.equal(wstgRiskRating(2, 1), "low");
  assert.equal(wstgRiskRating(1, 3), "low");
  assert.equal(wstgRiskRating(1, 1), "low");
  assert.equal(wstgRiskRating(undefined, undefined), undefined);
});

test("the engagement phase vocabulary is WSTG-only in the tool schema", () => {
  const properties = (toolRegistry.get("update_engagement_state")!.parameters as any).properties;
  const dataProperties = properties.data.properties;
  assert.ok(dataProperties.likelihood, "likelihood is a schema field");
  assert.ok(dataProperties.impactRating, "impactRating is a schema field");
  assert.ok(!dataProperties.severity, "severity is not declarable any more");
  assert.ok(!dataProperties.cvssScore && !dataProperties.cvssVector, "CVSS fields are gone");
  assert.ok(!dataProperties.asvsRequirement, "ASVS is gone");
  assert.ok(!dataProperties.apiRisk, "API Top 10 is gone");
  assert.ok(
    !properties.action.enum.includes("set_phase"),
    "the engagement has no phase state to set any more",
  );
});
