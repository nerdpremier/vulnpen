/**
 * Draft Web Application Penetration Testing Report builder.
 *
 * The report is generated deterministically from state the session already
 * holds — the structured findings, the OWASP WSTG v4.2 test plan and its
 * coverage — so a draft is always available without another model call. The
 * assistant can then tighten the prose, but the structure, the risk maths, the
 * WSTG references and the OWASP Top 10:2025 mapping are computed here rather
 * than invented by a model.
 *
 * Structure follows the WSTG v4.2 Reporting guidance (section 5): Introduction
 * (version control, table of contents, team, scope, limitations, timeline,
 * disclaimer), Executive summary, Findings (summary + details) and appendices
 * (methodology, risk-rating explanations, test-case inventory). The engagement
 * phases, the risk-rating method (likelihood x impact) and the report structure
 * all come from the WSTG itself, so the report answers to one guide.
 */

import {
  OWASP_TOP10_2025,
  WSTG_SOURCE,
  WSTG_VERSION,
  computeOwaspCoverage,
  getOwaspCategory,
  getWstgTest,
  normalizeOwaspTop10Id,
  wstgRiskRating,
} from "../../knowledge";
export { wstgRiskRating };
import type { OwaspTop10Id } from "../../knowledge";
import type {
  SessionVulnerabilityDoc,
  WebAppTestPlanDoc,
} from "../../models/Sessions/Sessions.model";
import { mapFindingToOwaspTop10, normalizeCwe } from "./owasp-mapping.service";
import { computeCoverage, TEST_PLAN_SOURCE } from "./test-plan.service";

export type Severity = "high" | "medium" | "low" | "info";

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];

const SEVERITY_RANK: Record<Severity, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export interface ReportOptions {
  session: {
    sessionId: string;
    name: string;
    description?: string;
    createdAt?: Date;
  };
  target?: string;
  scope?: string;
  client?: string;
  tester?: string;
  testingWindow?: string;
  classification?: string;
  version?: string;
  testType?: string;
  tools?: string[];
  engagementNotes?: string;
  limitations?: string;
  vulnerabilities: SessionVulnerabilityDoc[];
  testPlan?: WebAppTestPlanDoc | null;
  generatedAt?: Date;
}

export interface ReportFindingsRow {
  id: string;
  index: number;
  title: string;
  severity: Severity;
  host: string;
  endpoint?: string;
  wstgId?: string;
  owaspTop10?: OwaspTop10Id;
  owaspConfidence?: string;
  status: string;
  exploited: boolean;
  cwe?: string;
  mappingRationale: string;
  relatedOwasp: OwaspTop10Id[];
  /** official | curated | tester | model */
  owaspProvenance?: string;
  /** Likelihood and impact factors (1-3 scale) that feed the risk matrix. */
  likelihood?: number;
  impactRating?: number;
  /** Risk from the likelihood x impact matrix in Appendix B. */
  riskRating?: "high" | "medium" | "low";
}

export interface ReportStats {
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  exploited: number;
  unmapped: number;
  byOwasp: Array<{ id: OwaspTop10Id; title: string; findings: number }>;
  coverage: {
    total: number;
    executed: number;
    passed: number;
    failed: number;
    notStarted: number;
    percentExecuted: number;
  };
}

export interface WebAppPentestReport {
  title: string;
  fileName: string;
  markdown: string;
  generatedAt: Date;
  findings: ReportFindingsRow[];
  stats: ReportStats;
}

function tableCell(value: unknown): string {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " ")
    .trim() || "—";
}

function slug(value: string): string {
  return value
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "engagement";
}

function formatDate(value?: Date): string {
  const date = value ?? new Date();
  return date.toISOString().slice(0, 10);
}


/**
 * Mask secrets in evidence before it is placed in a report. WSTG Reporting asks
 * that sensitive data (passwords, tokens, keys, card numbers) be masked; this
 * is a best-effort redaction of the common patterns, not a guarantee.
 */
export function maskSensitive(text: string): string {
  return (text || "")
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|\x27[^\x27]*\x27|\S+)/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED-JWT]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED-CARD]")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1[REDACTED]$2");
}



function findingSort(a: SessionVulnerabilityDoc, b: SessionVulnerabilityDoc): number {
  const severityDelta =
    (SEVERITY_RANK[b.severity as Severity] ?? 0) - (SEVERITY_RANK[a.severity as Severity] ?? 0);
  if (severityDelta !== 0) return severityDelta;
  return (a.title ?? "").localeCompare(b.title ?? "");
}

/**
 * Findings arrive from several sources (agent tool calls and historical
 * backfills) so the classification is recomputed here whenever the stored one
 * is missing or invalid, and is never overwritten when the tester set it.
 */
export function buildReportFindings(
  vulnerabilities: SessionVulnerabilityDoc[],
): ReportFindingsRow[] {
  return [...vulnerabilities].sort(findingSort).map((vulnerability, index) => {
    const wstg = vulnerability.wstgId ? getWstgTest(vulnerability.wstgId) : undefined;
    const stored = normalizeOwaspTop10Id(vulnerability.owaspTop10);
    const mapping = mapFindingToOwaspTop10({
      title: vulnerability.title,
      description: vulnerability.description,
      contextSummary: vulnerability.contextSummary,
      evidence: vulnerability.evidence,
      endpoint: vulnerability.endpoint,
      service: vulnerability.service,
      cwe: vulnerability.cwe,
      wstgId: vulnerability.wstgId,
      owaspTop10: stored,
    });

    return {
      id: vulnerability.vulnerabilityId,
      index: index + 1,
      title: vulnerability.title,
      severity: (vulnerability.severity as Severity) ?? "info",
      host: vulnerability.host || "unknown",
      endpoint: vulnerability.endpoint,
      wstgId: wstg?.id ?? vulnerability.wstgId,
      owaspTop10: mapping.primary,
      owaspConfidence: stored ? "high" : mapping.confidence,
      status: vulnerability.status,
      exploited: !!vulnerability.exploited,
      cwe: normalizeCwe(vulnerability.cwe) || undefined,
      mappingRationale: vulnerability.owaspRationale || mapping.rationale,
      relatedOwasp: mapping.related,
      owaspProvenance: vulnerability.owaspProvenance || mapping.provenance,
      likelihood: vulnerability.likelihood,
      impactRating: vulnerability.impactRating,
      riskRating: wstgRiskRating(vulnerability.likelihood, vulnerability.impactRating),
    };
  });
}

/**
 * The finding document as structured JSON for a report-writing model
 * (/export): the report-relevant fields, projected next to the other finding
 * projections so a new field is added here, not re-listed at a call site.
 */
export function serializeFindingsForReport(
  vulnerabilities: SessionVulnerabilityDoc[],
): Record<string, unknown>[] {
  return vulnerabilities.map((v) => ({
    id: v.vulnerabilityId,
    title: v.title,
    severity: v.severity,
    likelihood: v.likelihood,
    impactRating: v.impactRating,
    cwe: v.cwe,
    cve: v.cve,
    host: v.host,
    service: v.service,
    endpoint: v.endpoint,
    description: v.description,
    contextSummary: v.contextSummary,
    evidence: v.evidence,
    stepsToReproduce: v.stepsToReproduce,
    impact: v.impact,
    remediation: v.remediation,
    exploited: v.exploited,
    status: v.status,
  }));
}

export function computeReportStats(
  findings: ReportFindingsRow[],
  testPlan?: WebAppTestPlanDoc | null,
): ReportStats {
  const bySeverity = SEVERITY_ORDER.reduce(
    (acc, severity) => {
      acc[severity] = findings.filter((finding) => finding.severity === severity).length;
      return acc;
    },
    {} as Record<Severity, number>,
  );

  const owaspCoverage = computeOwaspCoverage(findings);

  const coverage = computeCoverage(testPlan?.cases ?? []);

  return {
    totalFindings: owaspCoverage.total,
    bySeverity,
    exploited: findings.filter((finding) => finding.exploited).length,
    unmapped: owaspCoverage.unmapped,
    byOwasp: owaspCoverage.byOwasp,
    coverage: {
      total: coverage.total,
      executed: coverage.executed,
      passed: coverage.passed,
      failed: coverage.failed,
      notStarted: coverage.notStarted,
      percentExecuted: coverage.percentExecuted,
    },
  };
}

export function reportFileName(options: ReportOptions): string {
  const stamp = formatDate(options.generatedAt);
  return `${slug(options.target || options.session.name)}-web-app-pentest-report-${stamp}.md`;
}
function severityCountsLine(stats: ReportStats): string {
  const parts = SEVERITY_ORDER.filter((severity) => stats.bySeverity[severity] > 0).map(
    (severity) => `${stats.bySeverity[severity]} ${severity}`,
  );
  return parts.length ? parts.join(", ") : "no findings recorded";
}

function owaspTitle(id?: OwaspTop10Id): string {
  if (!id) return "Unmapped";
  return `${id} ${getOwaspCategory(id)?.title ?? ""}`.trim();
}

function introductionSection(options: ReportOptions, stats: ReportStats): string[] {
  const generatedAt = options.generatedAt ?? new Date();
  return [
    "## 1. Introduction",
    "",
    "### 1.1 Version control",
    "",
    "| Version | Description | Date | Author |",
    "| --- | --- | --- | --- |",
    `| ${tableCell(options.version ?? "1.0 (draft)")} | ${options.version ? "Updated draft" : "Initial report (draft)"} | ${formatDate(generatedAt)} | ${tableCell(options.tester ?? "Not specified")} |`,
    "",
    "### 1.2 Table of contents",
    "",
    "- 1. Introduction",
    "- 2. Executive summary",
    "- 3. Scope, methodology and limitations",
    "- 4. Risk summary",
    "- 5. Findings summary",
    "- 6. Detailed findings",
    "- 7. WSTG v" + WSTG_VERSION + " test coverage",
    "- 8. OWASP Top 10:2025 mapping",
    "- 9. Recommendations",
    "- 10. Appendix A - Test case inventory",
    "- 11. Appendix B - Risk rating methodology",
    "- 12. Appendix C - Glossary and references",
    "",
    "### 1.3 Test team",
    "",
    "| Name | Role | Qualifications |",
    "| --- | --- | --- |",
    `| ${tableCell(options.tester ?? "Not specified")} | Lead tester | OWASP WSTG v${WSTG_VERSION} methodology; web application penetration testing |`,
    "",
    "### 1.4 Engagement details",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Report title | ${tableCell(options.session.name)} — Web Application Penetration Test |`,
    `| Client | ${tableCell(options.client ?? "Not specified")} |`,
    `| Target | ${tableCell(options.target ?? "Not specified")} |`,
    `| Scope | ${tableCell(options.scope ?? "Not specified")} |`,
    `| Engagement type | ${tableCell(options.testType ?? "Grey-box web application penetration test")} |`,
    `| Testing window | ${tableCell(options.testingWindow ?? formatDate(generatedAt))} |`,
    `| Standards applied | OWASP WSTG v${WSTG_VERSION} (methodology, risk rating, report structure), OWASP Top 10:2025 (risk mapping), CWE (weakness classification) |`,
    `| Assessment session | ${tableCell(options.session.name)} (${tableCell(options.session.sessionId)}) |`,
    `| Tester | ${tableCell(options.tester ?? "Not specified")} |`,
    `| Report version | ${tableCell(options.version ?? "1.0 (draft)")} |`,
    `| Classification | ${tableCell(options.classification ?? "Confidential")} |`,
    `| Generated | ${generatedAt.toISOString()} |`,
    `| Status | DRAFT — generated from session evidence; review before delivery |`,
    `| Findings | ${stats.totalFindings} (${severityCountsLine(stats)}) |`,
    "",
    "### 1.5 Disclaimer",
    "",
    "This test is a point-in-time assessment; the environment may have changed since it was run. There is no guarantee that every possible security issue has been identified, or that new vulnerabilities have not since been discovered. This report is a guiding document, not a warranty of the state of the systems tested.",
    "",
    "### 1.6 Timeline",
    "",
    "| Milestone | Date |",
    "| --- | --- |",
    `| Engagement session created | ${formatDate(options.session.createdAt)} |`,
    `| Report generated | ${generatedAt.toISOString()} |`,
    "",
    "### 1.7 Standards and references applied",
    "",
    `- OWASP Web Security Testing Guide v${WSTG_VERSION} - methodology, risk rating and report structure (${WSTG_SOURCE})`,
    "- OWASP WSTG v4.2 Reporting guidance (https://wstg.owasp.org/v4.2/5-Reporting/)",
    "- OWASP Risk Rating Methodology - the likelihood x impact matrix, with the two factors carrying equal weight (https://owasp.org/www-project-risk-rating-methodology/)",
    "- OWASP Top 10:2025 - risk vocabulary (https://owasp.org/Top10/2025/)",
    "- CWE - weakness classification (https://cwe.mitre.org/)",
    "",
  ];
}

function executiveSummarySection(options: ReportOptions, findings: ReportFindingsRow[], stats: ReportStats): string[] {
  const lines: string[] = ["## 2. Executive summary", ""];
  const highCount = stats.bySeverity.high;

  lines.push(
    `A web application security assessment of ${options.target || options.session.name} was performed using the OWASP Web Security Testing Guide v${WSTG_VERSION}. ${stats.totalFindings} security finding(s) were recorded (${severityCountsLine(stats)}).`,
  );
  lines.push("");

  if (stats.exploited > 0) {
    lines.push(
      `${stats.exploited} finding(s) were exploited during the assessment, which means the impact is demonstrated rather than theoretical.`,
    );
    lines.push("");
  }

  if (highCount > 0) {
    lines.push(
      `The engagement identified ${highCount} high severity issue(s). These should be treated as release-blocking until remediated or formally accepted.`,
    );
    lines.push("");
  } else if (stats.totalFindings > 0) {
    lines.push(
      "No high severity issues were identified within the tested scope. The remaining findings are medium, low or informational and indicate hardening opportunities.",
    );
    lines.push("");
  }

  const top = findings.slice(0, 5);
  if (top.length) {
    lines.push("**Principal findings**", "");
    for (const finding of top) {
      lines.push(
        `- **F-${String(finding.index).padStart(3, "0")} ${finding.title}** (${finding.severity}${finding.riskRating ? `, risk ${finding.riskRating}` : ""}) — ${finding.host}${finding.endpoint ? ` ${finding.endpoint}` : ""}. ${owaspTitle(finding.owaspTop10)}.`,
      );
    }
    lines.push("");
  }

  lines.push(
    `**Test coverage:** ${stats.coverage.executed} of ${stats.coverage.total} planned WSTG test cases were executed (${stats.coverage.percentExecuted}%). ${stats.coverage.notStarted} test case(s) were not executed in this window; they are listed in section 7 and any residual risk from them is unverified.`,
  );
  lines.push("");

  if (stats.unmapped > 0) {
    lines.push(
      `> ${stats.unmapped} finding(s) could not be mapped to the OWASP Top 10:2025 automatically. They are marked "Unmapped" and need a manual classification before delivery.`,
    );
    lines.push("");
  }

  lines.push(
    "> This executive summary is generated from recorded evidence. Every statement must be verified against the detailed findings before the report is issued.",
  );
  return lines;
}

function scopeAndMethodologySection(options: ReportOptions, findings: ReportFindingsRow[]): string[] {
  const hosts = Array.from(new Set(findings.map((finding) => finding.host).filter(Boolean)));
  const lines: string[] = [
    "## 3. Scope, methodology and limitations",
    "",
    "### 3.1 In scope",
    "",
    options.scope || options.target
      ? `${options.scope || options.target}`
      : "No scope statement was recorded in this session.",
    "",
  ];

  if (hosts.length) {
    lines.push("Assets touched during testing:", "");
    for (const host of hosts) lines.push(`- ${host}`);
    lines.push("");
  }

  lines.push(
    "### 3.2 Methodology",
    "",
    `Testing followed the OWASP Web Security Testing Guide (WSTG) v${WSTG_VERSION} (${WSTG_SOURCE}). Each planned test case carries its WSTG identifier, objective, method and the evidence expected from it; results are tracked per case with the statuses passed, failed, blocked, in progress, skipped and not started.`,
    "",
    "Findings were mapped to the OWASP Top 10:2025 (https://owasp.org/Top10/2025/) using the following precedence: an explicit tester classification; then this project's curated WSTG-to-Top-10 crosswalk (a mapping maintained here, NOT an OWASP publication); then the CWE identifiers OWASP publishes for each category (an official signal); then an LLM classifier that must state its rationale. Every mapping keeps its source (official, curated, tester or model) and confidence level for audit, and the source is shown on each finding.",
    "",
  );

  if (options.tools?.length) {
    lines.push(`Tools and techniques used: ${options.tools.join(", ")}.`, "");
  }

  if (options.engagementNotes) {
    lines.push("### 3.3 Engagement notes", "", options.engagementNotes, "");
  }

  lines.push(
    "### 3.4 Assumptions and limitations",
    "",
    options.limitations ||
      "Findings are limited to the scope, credentials and time window available for this assessment. Untested or blocked test cases are recorded in section 7 and represent unverified risk rather than confirmed absence of a vulnerability.",
    "",
  );

  return lines;
}

function riskSummarySection(findings: ReportFindingsRow[], stats: ReportStats): string[] {
  const lines: string[] = [
    "## 4. Risk summary",
    "",
    "### 4.1 Findings by severity",
    "",
    "| Severity | Findings | Exploited |",
    "| --- | --- | --- |",
  ];
  for (const severity of SEVERITY_ORDER) {
    const rows = findings.filter((finding) => finding.severity === severity);
    lines.push(
      `| ${severity} | ${rows.length} | ${rows.filter((row) => row.exploited).length} |`,
    );
  }
  lines.push(`| **Total** | **${stats.totalFindings}** | **${stats.exploited}** |`, "");

  lines.push(
    "### 4.2 Findings by OWASP Top 10:2025 category",
    "",
    "| OWASP Top 10:2025 | Category | Findings |",
    "| --- | --- | --- |",
  );
  for (const category of stats.byOwasp) {
    lines.push(`| ${category.id} | ${category.title} | ${category.findings} |`);
  }
  if (stats.unmapped > 0) {
    lines.push(`| — | Unmapped (needs manual classification) | ${stats.unmapped} |`);
  }
  lines.push("");
  return lines;
}

function findingsSummarySection(findings: ReportFindingsRow[]): string[] {
  const lines: string[] = [
    "## 5. Findings summary",
    "",
    "| ID | Severity | Risk | Title | Affected asset | WSTG | OWASP Top 10:2025 | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  if (!findings.length) {
    lines.push("| — | — | — | No findings were recorded in this session | — | — | — | — |");
  }
  for (const finding of findings) {
    lines.push(
      `| F-${String(finding.index).padStart(3, "0")} | ${finding.severity}${finding.exploited ? " (exploited)" : ""} | ${finding.riskRating ?? "—"} | ${tableCell(finding.title)} | ${tableCell(finding.host)}${finding.endpoint ? `<br>${tableCell(finding.endpoint)}` : ""} | ${finding.wstgId ?? "—"} | ${owaspTitle(finding.owaspTop10)} | ${finding.status} |`,
    );
  }
  lines.push("");
  return lines;
}

function detailedFindingsSection(
  findings: ReportFindingsRow[],
  vulnerabilities: SessionVulnerabilityDoc[],
): string[] {
  const byId = new Map(vulnerabilities.map((vulnerability) => [vulnerability.vulnerabilityId, vulnerability]));
  const lines: string[] = ["## 6. Detailed findings", ""];

  if (!findings.length) {
    lines.push(
      "No findings were recorded during this assessment. Coverage in section 7 shows which test cases support that statement.",
      "",
    );
    return lines;
  }

  for (const finding of findings) {
    const vulnerability = byId.get(finding.id);
    const wstg = finding.wstgId ? getWstgTest(finding.wstgId) : undefined;
    const category = getOwaspCategory(finding.owaspTop10);

    lines.push(`### 6.${finding.index} F-${String(finding.index).padStart(3, "0")} — ${finding.title}`, "");
    lines.push("| Attribute | Value |", "| --- | --- |");
    lines.push(`| Severity | ${finding.severity}${finding.exploited ? " (exploited)" : ""} |`);

    lines.push(`| Affected asset | ${tableCell(finding.host)}${finding.endpoint ? ` — ${tableCell(finding.endpoint)}` : vulnerability?.service ? ` — ${tableCell(vulnerability.service)}` : ""} |`);
    lines.push(`| CWE | ${finding.cwe ?? "Not recorded"} |`);
    // 1-3 scale: 1 = low, 2 = medium, 3 = high. See Appendix B for the matrix.
    const factor = (n?: number) => (n === 3 ? "high" : n === 2 ? "medium" : n === 1 ? "low" : "not recorded");
    lines.push(
      `| Likelihood | ${factor(finding.likelihood)}${finding.likelihood != null ? ` (${finding.likelihood}/3)` : ""} |`,
      `| Impact | ${factor(finding.impactRating)}${finding.impactRating != null ? ` (${finding.impactRating}/3)` : ""} |`,
      `| Risk (likelihood x impact, equal weight) | ${finding.riskRating ?? "Not rated"} |`,
    );
    if (vulnerability?.cve) lines.push(`| CVE | ${tableCell(vulnerability.cve)} |`);
    lines.push(`| OWASP Top 10:2025 | ${owaspTitle(finding.owaspTop10)}${finding.relatedOwasp.length ? ` (also related: ${finding.relatedOwasp.join(", ")})` : ""} |`);
    lines.push(`| Classification basis | ${tableCell(finding.mappingRationale)} |`);
    lines.push(
      `| WSTG v${WSTG_VERSION} reference | ${wstg ? `${wstg.id} (${wstg.section}) ${wstg.title}` : finding.wstgId ?? "No WSTG test case linked — link the finding to the case that produced it"} |`,
    );
    lines.push(`| Status | ${finding.status} |`);
    lines.push("");

    lines.push("**Description**", "");
    lines.push(
      vulnerability?.description || vulnerability?.contextSummary || "No description was recorded for this finding.",
      "",
    );

    if (vulnerability?.contextSummary && vulnerability.contextSummary !== vulnerability.description) {
      lines.push("**Context**", "", vulnerability.contextSummary, "");
    }

    if (wstg) {
      lines.push("**How it was tested (WSTG method)**", "", `${wstg.objective} ${wstg.howToTest}`, "");
    }

    lines.push("**Evidence**", "");
    lines.push("```text");
    lines.push(maskSensitive((vulnerability?.evidence || "No raw evidence was captured.").trim()));
    lines.push("```", "");
    lines.push(
      "> Evidence is redacted for secrets, tokens, keys and card-like numbers before it enters the report (WSTG Reporting: mask sensitive data). Verify the redaction before delivery.",
      "",
    );

    if (vulnerability?.stepsToReproduce?.length) {
      lines.push("**Steps to reproduce**", "");
      vulnerability.stepsToReproduce.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
      lines.push("");
    }

    lines.push("**Impact**", "", vulnerability?.impact || "Impact was not recorded. Assess and complete before delivery.", "");
    lines.push(
      "**Remediation**",
      "",
      vulnerability?.remediation || category?.remediation.map((item) => `- ${item}`).join("\n") || "Remediation was not recorded.",
      "",
    );

    const references: string[] = [];
    if (wstg) references.push(`- OWASP WSTG v${WSTG_VERSION} ${wstg.id}: ${WSTG_SOURCE}/blob/master/document/4-Web_Application_Security_Testing`);
    if (category) references.push(`- OWASP Top 10:2025 ${category.id} ${category.title}: https://owasp.org/Top10/2025/`);
    if (finding.cwe) {
      references.push(`- ${finding.cwe}: https://cwe.mitre.org/data/definitions/${finding.cwe.replace(/\D/g, "")}.html`);
    }
    if (finding.owaspProvenance) {
      references.push(
        `- OWASP mapping provenance: ${finding.owaspProvenance}` +
          (finding.owaspProvenance === "curated"
            ? " (this project's WSTG-to-Top-10 crosswalk; OWASP publishes no such mapping)"
            : finding.owaspProvenance === "official"
              ? " (the CWE list OWASP publishes for this category)"
              : ""),
      );
    }
    if (references.length) lines.push("**References**", "", ...references, "");
  }

  return lines;
}

function wstgCoverageSection(plan?: WebAppTestPlanDoc | null): string[] {
  const lines: string[] = ["## 7. WSTG v" + WSTG_VERSION + " test coverage", ""];

  if (!plan || !plan.cases?.length) {
    lines.push(
      "No WSTG test plan was recorded for this session, so coverage cannot be evidenced. Generate a plan with the wstg_test_plan tool and re-run the assessment to produce a coverage-backed report.",
      "",
    );
    return lines;
  }

  const coverage = computeCoverage(plan.cases);
  lines.push(
    `Plan source: ${TEST_PLAN_SOURCE}, generated ${formatDate(plan.createdAt)}. Executed ${coverage.executed}/${coverage.total} cases (${coverage.percentExecuted}%): ${coverage.passed} passed, ${coverage.failed} failed, ${coverage.blocked} blocked, ${coverage.inProgress} in progress, ${coverage.skipped} skipped, ${coverage.notStarted} not started.`,
    "",
    "| WSTG section | Category | Planned | Executed | Passed | Failed | Blocked |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of coverage.byCategory) {
    const section = plan.cases.find((testCase) => testCase.categoryCode === row.key)?.section ?? "";
    lines.push(
      `| ${section || row.key} | ${row.label} | ${row.total} | ${row.executed} | ${row.passed} | ${row.failed} | ${row.blocked} |`,
    );
  }
  lines.push("");

  const failed = plan.cases.filter((testCase) => testCase.status === "failed");
  if (failed.length) {
    lines.push("### 7.1 Tests that produced findings", "");
    for (const testCase of failed) {
      lines.push(
        `- ${testCase.testId} (${testCase.section}) ${testCase.title}; linked findings: ${testCase.linkedVulnerabilityIds?.length ? testCase.linkedVulnerabilityIds.join(", ") : "none recorded"}`,
      );
    }
    lines.push("");
  }

  const blocked = plan.cases.filter((testCase) => testCase.status === "blocked");
  if (blocked.length) {
    lines.push("### 7.2 Blocked test cases", "");
    for (const testCase of blocked) {
      lines.push(`- ${testCase.testId} ${testCase.title} — ${testCase.notes || "reason not recorded"}`);
    }
    lines.push("");
  }

  const notStarted = plan.cases.filter((testCase) => testCase.status === "not_started");
  if (notStarted.length) {
    lines.push("### 7.3 Not tested (residual risk)", "");
    lines.push(
      "The following planned test cases were not executed. They are unverified, not negative results:",
      "",
    );
    for (const testCase of notStarted.slice(0, 60)) {
      lines.push(`- ${testCase.testId} (${testCase.section}) ${testCase.title}`);
    }
    if (notStarted.length > 60) {
      lines.push(`- ...and ${notStarted.length - 60} further cases listed in the session test plan.`);
    }
    lines.push("");
  }

  return lines;
}

function owaspMappingSection(stats: ReportStats): string[] {
  const lines: string[] = [
    "## 8. OWASP Top 10:2025 mapping",
    "",
    'The OWASP Top 10:2025 mapping is recorded on the findings themselves (section 6). A finding is only classified when the evidence supports a category; findings with no well-fitting category are listed as "Unmapped" rather than forced into one.',
    "",
    "| Category | Findings | Notable WSTG tests |",
    "| --- | --- | --- |",
  ];

  for (const category of OWASP_TOP10_2025) {
    const findings = stats.byOwasp.find((entry) => entry.id === category.id)?.findings ?? 0;
    const tests = (category.wstgFocus ?? []).slice(0, 4).join(", ") || "—";
    lines.push(`| ${category.id} ${category.title} | ${findings} | ${tests} |`);
  }
  if (stats.unmapped > 0) {
    lines.push(`| Unmapped | ${stats.unmapped} | Add a CWE or WSTG test reference to classify — or leave unmapped when nothing fits |`);
  }
  lines.push("");

  const affected = stats.byOwasp.filter((entry) => entry.findings > 0);
  if (affected.length) {
    lines.push("### 8.1 Programme-level guidance for the categories present", "");
    for (const entry of affected) {
      const category = getOwaspCategory(entry.id);
      if (!category) continue;
      lines.push(`**${category.id} ${category.title}** — ${category.summary}`, "");
      for (const item of category.remediation.slice(0, 4)) lines.push(`- ${item}`);
      lines.push("");
    }
  }

  return lines;
}

function recommendationsSection(
  findings: ReportFindingsRow[],
  vulnerabilities: SessionVulnerabilityDoc[],
): string[] {
  const byId = new Map(vulnerabilities.map((vulnerability) => [vulnerability.vulnerabilityId, vulnerability]));
  const lines: string[] = ["## 9. Recommendations", ""];
  const label = (finding: ReportFindingsRow) =>
    `**F-${String(finding.index).padStart(3, "0")} ${finding.title}** (${finding.host}${finding.endpoint ? ` ${finding.endpoint}` : ""})`;
  const remediation = (finding: ReportFindingsRow) =>
    byId.get(finding.id)?.remediation || "No remediation recorded — define one before delivery.";

  const groups: Array<{ title: string; severities: Severity[] }> = [
    { title: "### 9.1 Immediate (within 7 days)", severities: ["high"] },
    { title: "### 9.2 Short term (within 30 days)", severities: ["medium"] },
    { title: "### 9.3 Hardening backlog (next release cycle)", severities: ["low", "info"] },
  ];

  for (const group of groups) {
    lines.push(group.title, "");
    const rows = findings.filter((finding) => group.severities.includes(finding.severity));
    if (!rows.length) {
      lines.push(
        group.severities.includes("high")
          ? "- No high severity findings are outstanding."
          : "- Nothing outstanding in this band.",
      );
    }
    for (const finding of rows) {
      lines.push(`- ${label(finding)}: ${remediation(finding)}`);
    }
    lines.push("");
  }

  lines.push("### 9.4 Process recommendations", "");
  lines.push(
    "- Re-run the WSTG v" + WSTG_VERSION + " test plan after remediation and attach the updated coverage table to the next report version.",
  );
  lines.push(
    "- Close the not-tested cases in section 7.3 in the next testing window; they are unverified risk, not clean results.",
  );
  lines.push(
    "- Keep the OWASP Top 10:2025 mapping on every tracked finding so that risk reporting stays comparable across releases.",
  );
  lines.push("");
  return lines;
}

function appendixSection(plan?: WebAppTestPlanDoc | null): string[] {
  const lines: string[] = ["## 10. Appendix A — Test case inventory", ""];

  if (!plan?.cases?.length) {
    lines.push("No test plan was recorded for this session.", "");
  } else {
    lines.push(
      "| WSTG ID | Section | Test case | Status | Observations | Linked findings |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const testCase of plan.cases) {
      lines.push(
        `| ${testCase.testId} | ${testCase.section} | ${tableCell(testCase.title)} | ${testCase.status} | ${tableCell(truncateText(testCase.observations || testCase.notes, 120))} | ${testCase.linkedVulnerabilityIds?.length ? testCase.linkedVulnerabilityIds.join(", ") : "—"} |`,
      );
    }
    lines.push("");
    lines.push(
      "This inventory is the WSTG v4.2 checklist for the engagement. The published checklist lives at https://github.com/OWASP/wstg/tree/master/checklist. Coverage is measured against the in-scope cases, and a case that could not apply is recorded blocked, never counted as a pass. On a re-test, compare each case against its previous run and summarise what changed.",
      "",
    );
  }

  lines.push(
    "## 11. Appendix B - Risk rating methodology",
    "",
    "Risk is rated from two factors, as the WSTG Reporting guidance asks for: the likelihood (or exploitability) of the issue, and its impact. Each factor is recorded on a three-point scale, 1 = low, 2 = medium, 3 = high. The two factors carry equal weight and are combined with the matrix below to give the severity — a declared severity word is never accepted on its own.",
    "",
    "| Likelihood | Impact: Low | Impact: Medium | Impact: High |",
    "| --- | --- | --- | --- |",
    "| High (3) | Low | Medium | High |",
    "| Medium (2) | Low | Medium | Medium |",
    "| Low (1) | Low | Low | Low |",
    "",
    "Findings are labelled Low, Medium or High from the matrix, or Informational when the factors have not been rated yet. Severity always follows the recorded factors: the tester rates likelihood and impact, the matrix decides.",
    "",
    "| Risk | Response |",
    "| --- | --- |",
    "| High | Remediate urgently on the current cycle; treat as an active exposure until fixed. |",
    "| Medium | Remediate on a planned cycle. |",
    "| Low | Harden opportunistically. |",
    "| Informational | No action required; recorded for completeness. |",
    "",
    "## 12. Appendix C - Glossary and references",
    "",
    "| Term | Meaning |",
    "| --- | --- |",
    "| WSTG | OWASP Web Security Testing Guide — the test methodology applied here. |",
    "| WSTG ID | Identifier of a single WSTG test case, e.g. WSTG-INPV-05. |",
    "| OWASP Top 10:2025 | OWASP's 2025 awareness list of the ten most critical web application security risks. |",
    "| CWE | Common Weakness Enumeration identifier for the underlying weakness class. |",
    "| IDOR | Insecure Direct Object Reference — accessing objects by manipulating identifiers. |",
    "| SSRF | Server-Side Request Forgery — the server fetches a URL controlled by the attacker. |",
    "| CSRF | Cross-Site Request Forgery — state change forced through a victim's session. |",
    "",
    "**References**",
    "",
    `- OWASP Web Security Testing Guide v${WSTG_VERSION}: ${WSTG_SOURCE}`,
    "- OWASP Top 10:2025: https://owasp.org/Top10/2025/",
    "- OWASP WSTG v4.2 Reporting guidance: https://wstg.owasp.org/v4.2/5-Reporting/",
    "- CWE: https://cwe.mitre.org/",
    "",
    "---",
    "",
    "*This draft was generated by the assistant from session evidence, the session WSTG test plan and the OWASP Top 10:2025 mapping. Review every section, complete anything marked as not recorded, and remove this note before issuing the report.*",
    "",
  );
  return lines;
}

function truncateText(value: string, max: number): string {
  const text = (value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function buildWebAppPentestReport(options: ReportOptions): WebAppPentestReport {
  const generatedAt = options.generatedAt ?? new Date();
  const resolved: ReportOptions = { ...options, generatedAt };
  const vulnerabilities = options.vulnerabilities ?? [];
  const findings = buildReportFindings(vulnerabilities);
  const stats = computeReportStats(findings, options.testPlan);
  const title = `${options.session.name} — Web Application Penetration Testing Report (draft)`;

  const markdown = [
    `# ${title}`,
    "",
    `*Draft generated ${generatedAt.toISOString()} from session \`${options.session.sessionId}\` using ${TEST_PLAN_SOURCE} and the OWASP Top 10:2025.*`,
    "",
    "---",
    "",
    ...introductionSection(resolved, stats),
    ...executiveSummarySection(resolved, findings, stats),
    ...scopeAndMethodologySection(resolved, findings),
    ...riskSummarySection(findings, stats),
    ...findingsSummarySection(findings),
    ...detailedFindingsSection(findings, vulnerabilities),
    ...wstgCoverageSection(options.testPlan),
    ...owaspMappingSection(stats),
    ...recommendationsSection(findings, vulnerabilities),
    ...appendixSection(options.testPlan),
  ].join("\n");

  return {
    title,
    fileName: reportFileName(resolved),
    markdown,
    generatedAt,
    findings,
    stats,
  };
}
