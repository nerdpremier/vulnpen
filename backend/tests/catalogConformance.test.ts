import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OWASP_TOP10_2025,
  cvssBaseScore,
  cvssVectorString,
  cvssV2BaseScore,
  cvssV2VectorString,
  deriveCvssV2Metrics,
  deriveCvssV4Vector,
  computeCvssBase,
  cvssQualitativeRating,
  normalizeCvssBaseMetrics,
  parseCvssVector,
  severityFromCvssScore,
  type CvssBaseMetrics,
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
    av: "N",
    ac: "L",
    pr: "N",
    ui: "N",
    s: "U",
    c: "H",
    i: "H",
    a: "H",
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
  assert.equal(vulnerability.severity, "critical", "9.8 on the CVSS v3.0 scale is critical");
  assert.equal(vulnerability.cvss?.score, 9.8);

  const report = buildWebAppPentestReport({
    session: { sessionId: "s1", name: "Example engagement", createdAt: new Date("2026-01-01T00:00:00Z") },
    target: "https://shop.example.test",
    tester: "A. Tester",
    vulnerabilities: [vulnerability],
  });

  const headings = [
    "## 1. Introduction",
    "### 1.1 Engagement details",
    "### 1.2 Disclaimer",
    "## 2. Executive summary",
    "## 11. Appendix B - Risk rating methodology (CVSS v3.0)",
    "## 12. Appendix C - Glossary and references",
  ];
  for (const heading of headings) {
    assert.ok(report.markdown.includes(heading), "missing " + heading);
  }

  assert.ok(report.markdown.includes("WSTG Reporting guidance"), "WSTG Reporting is cited");
  assert.ok(report.markdown.includes("https://www.first.org/cvss/calculator/3.0"), "the FIRST calculator is cited");
  assert.ok(!report.markdown.includes("Hunter2"), "the secret is masked in the report");
  assert.ok(/password=\[REDACTED\]/i.test(report.markdown), "the masked secret is present");
  assert.ok(report.findings[0].owaspProvenance, "the finding records a mapping provenance");
  assert.ok(report.markdown.includes("| CVSS v3.0 base score | 9.8 (critical) |"), "the base score is reported");
  assert.ok(
    report.markdown.includes("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    "the vector string is reported so the score is reproducible",
  );
});

// Reference vectors from the FIRST CVSS v3.0 specification / calculator
// (https://www.first.org/cvss/calculator/3.0). If these drift, the equation
// implementation is wrong, not the catalogue.
const BASE_METRICS: CvssBaseMetrics = {
  av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H",
};

test("the base score equation reproduces the FIRST calculator", () => {
  assert.equal(cvssBaseScore(BASE_METRICS), 9.8, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H is 9.8");
  assert.equal(
    cvssBaseScore({ ...BASE_METRICS, s: "C" }),
    10.0,
    "scope-changed full impact is 10.0",
  );
  assert.equal(
    cvssBaseScore({ ...BASE_METRICS, ac: "H" }),
    8.1,
    "AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H is 8.1",
  );
  assert.equal(
    cvssBaseScore({ ...BASE_METRICS, av: "L", pr: "L", c: "H", i: "N", a: "N" }),
    5.5,
    "AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N is 5.5",
  );
  assert.equal(
    cvssBaseScore({ ...BASE_METRICS, av: "P", ac: "H", pr: "H", ui: "R", c: "N", i: "N", a: "N" }),
    0.0,
    "no impact is 0.0",
  );
});

// Reference vectors from the FIRST CVSS v2.0 guide
// (https://www.first.org/cvss/v2/guide). Derived from the same v3 metrics:
// PR→Authentication, C/I/A→none/partial/complete.
test("the v2.0 base score equation reproduces the FIRST guide", () => {
  assert.equal(
    cvssV2BaseScore({ av: "N", ac: "L", au: "N", c: "N", i: "N", a: "C" }),
    7.8,
    "AV:N/AC:L/Au:N/C:N/I:N/A:C is 7.8 (CVE-2002-0392)",
  );
  assert.equal(
    cvssV2BaseScore({ av: "N", ac: "L", au: "N", c: "C", i: "C", a: "C" }),
    10.0,
    "AV:N/AC:L/Au:N/C:C/I:C/A:C is 10.0 (CVE-2003-0818)",
  );
  assert.equal(cvssV2BaseScore({ av: "N", ac: "L", au: "N", c: "N", i: "N", a: "N" }), 0.0);
});

test("v2.0 and v4.0 are derived from the v3.0 base metrics", () => {
  const v2 = deriveCvssV2Metrics(BASE_METRICS);
  assert.deepEqual(v2, { av: "N", ac: "L", au: "N", c: "C", i: "C", a: "C" });
  assert.equal(cvssV2VectorString(v2), "AV:N/AC:L/Au:N/C:C/I:C/A:C");
  const v4Vector = deriveCvssV4Vector(BASE_METRICS);
  assert.equal(
    v4Vector,
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
  );
});

test("computeCvssBase scores the finding in all three versions", () => {
  const scored = computeCvssBase(BASE_METRICS);
  assert.equal(scored.score, 9.8);
  assert.equal(scored.v2.score, 10.0);
  assert.equal(scored.v4.score, 9.3);
  assert.equal(scored.v2.vector, "AV:N/AC:L/Au:N/C:C/I:C/A:C");
  assert.equal(
    scored.v4.vector,
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
  );
});

test("the severity bands follow the FIRST qualitative ratings", () => {
  assert.equal(cvssQualitativeRating(0), "none");
  assert.equal(cvssQualitativeRating(3.9), "low");
  assert.equal(cvssQualitativeRating(4), "medium");
  assert.equal(cvssQualitativeRating(6.9), "medium");
  assert.equal(cvssQualitativeRating(7), "high");
  assert.equal(cvssQualitativeRating(8.9), "high");
  assert.equal(cvssQualitativeRating(9), "critical");
  assert.equal(severityFromCvssScore(0), "info", "CVSS None maps to the informational band");
  assert.equal(severityFromCvssScore(9.8), "critical");
});

test("metric normalization accepts complete ratings only", () => {
  const full = normalizeCvssBaseMetrics({ av: "n", attackVector: undefined, ac: "L", pr: "N", ui: "R", s: "C", c: "L", i: "L", a: "N" });
  assert.ok(full, "a complete rating (case-insensitive) normalizes");
  assert.deepEqual(full, { av: "N", ac: "L", pr: "N", ui: "R", s: "C", c: "L", i: "L", a: "N" });
  assert.equal(normalizeCvssBaseMetrics({ av: "N", ac: "L" }), undefined, "a partial rating is never scored");
  assert.equal(normalizeCvssBaseMetrics({ av: "X", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" }), undefined);
  assert.equal(
    parseCvssVector("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")?.a,
    "H",
    "the full vector string parses",
  );
  assert.equal(parseCvssVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")?.c, "H");
  assert.equal(parseCvssVector("not a vector"), undefined);
  assert.equal(
    cvssVectorString(normalizeCvssBaseMetrics({ av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" }!)),
    "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  );
});

test("the engagement phase vocabulary is WSTG-only in the tool schema", () => {
  const properties = (toolRegistry.get("update_engagement_state")!.parameters as any).properties;
  const dataProperties = properties.data.properties;
  for (const metric of ["av", "ac", "pr", "ui", "s", "c", "i", "a"]) {
    assert.ok(dataProperties[metric], `${metric} is a schema field`);
  }
  assert.ok(!dataProperties.likelihood, "the legacy likelihood factor is gone");
  assert.ok(!dataProperties.impactRating, "the legacy impactRating factor is gone");
  assert.ok(!dataProperties.severity, "severity is not declarable any more");
  assert.ok(!dataProperties.cvssScore && !dataProperties.cvssVector, "the score is computed, never declared");
  assert.ok(!dataProperties.asvsRequirement, "ASVS is gone");
  assert.ok(!dataProperties.apiRisk, "API Top 10 is gone");
  assert.ok(
    !properties.action.enum.includes("set_phase"),
    "the engagement has no phase state to set any more",
  );
});
