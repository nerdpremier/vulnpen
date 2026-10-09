/**
 * The report: what was found, and nothing else.
 *
 * The document is the model's opening summary, the risk table computed from the
 * findings, and one card per finding filled from the session's own records. It
 * deliberately carries no cover page, document-details block, abbreviation
 * list, revision history, tester list, terms of use or table of contents, and
 * no rationale / objectives / methodology chapters: that material was identical
 * for every engagement and pushed the actual vulnerabilities past the first ten
 * pages. The reviewer's guide to the risk bands lives on the finding cards,
 * which carry the CVSS score and vector the score came from.
 *
 * The output is a typed block list so the frontend preview and the .docx
 * exporter render the same document from one source. Engineering-only metadata
 * (mapping provenance, classification basis, coverage bookkeeping) is
 * deliberately kept out of this document.
 */

import { getOwaspCategory, getWstgTest } from "../../knowledge";
import type { SessionVulnerabilityDoc } from "../../models/Sessions/Sessions.model";
import {
  buildReportFindings,
  computeReportStats,
  maskSensitive,
  reportFileName,
  type ReportFindingsRow,
  type ReportOptions,
  type ReportStats,
  type Severity,
} from "./report.service";

export type ThaiLevel = "วิกฤต" | "สูง" | "ปานกลาง" | "ต่ำ" | "ข้อมูลข่าวสาร" | "ไม่ได้ประเมิน";

export interface ClientFinding {
  code: string;
  title: string;
  owasp: string;
  goal: string;
  method: string;
  discoveredOn: string;
  risk: ThaiLevel;
  cvssScore?: string;
  cvssVector?: string;
  discovered: string[];
  steps: string[];
  impactDetails: string[];
  recommendations: string[];
  references: string[];
  evidence: string;
  band: "red" | "orange" | "yellow" | "grey";
}

export type ClientBlock =
  | { type: "h1"; text: string }
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "numbers"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "finding"; finding: ClientFinding };

export interface ClientReport {
  fileName: string;
  /** Document heading, e.g. "รายงานช่องโหว่". */
  title: string;
  /** The engagement line under the heading. */
  subtitle: string;
  body: ClientBlock[];
}

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

function thaiDate(value?: Date): string {
  const date = value ?? new Date();
  return `${date.getDate()} ${THAI_MONTHS[date.getMonth()]} ${date.getFullYear() + 543}`;
}

function thaiSeverity(severity: Severity): ThaiLevel {
  return severity === "critical"
    ? "วิกฤต"
    : severity === "high"
      ? "สูง"
      : severity === "medium"
        ? "ปานกลาง"
        : severity === "low"
          ? "ต่ำ"
          : "ข้อมูลข่าวสาร";
}

function bandFor(level: ThaiLevel): ClientFinding["band"] {
  if (level === "วิกฤต" || level === "สูง") return "red";
  if (level === "ปานกลาง") return "orange";
  if (level === "ต่ำ") return "yellow";
  return "grey";
}

function splitRemediation(text: string): string[] {
  return text
    .split(/\r?\n|(?<=\.)\s{2,}/)
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

function buildFindingCard(
  index: number,
  finding: ReportFindingsRow,
  vulnerability: SessionVulnerabilityDoc | undefined,
  options: ReportOptions,
): ClientFinding {
  const wstg = finding.wstgId ? getWstgTest(finding.wstgId) : undefined;
  const category = getOwaspCategory(finding.owaspTop10);
  const riskLevel = thaiSeverity(finding.severity);
  const cvss = vulnerability?.cvss ?? finding.cvss;

  const impactDetails: string[] = [];
  if (vulnerability?.impact) impactDetails.push(vulnerability.impact.trim());
  if (!impactDetails.length) {
    impactDetails.push(
      "ช่องโหว่นี้อาจส่งผลต่อความลับของข้อมูล ความถูกต้องของระบบ หรือการให้บริการของระบบที่ทดสอบ ผู้ประเมินควรประเมินผลกระทบเชิงธุรกิจเพิ่มเติมก่อนนำส่ง",
    );
  }

  const recommendations = vulnerability?.remediation
    ? splitRemediation(vulnerability.remediation)
    : category?.remediation.slice(0, 4) ?? ["ยังไม่ได้บันทึกแนวทางแก้ไข ผู้ประเมินควรระบุแนวทางก่อนนำส่งรายงาน"];

  const references: string[] = [];
  if (wstg) references.push(`OWASP WSTG v4.2 ${wstg.id}: ${wstg.title}`);
  if (category) references.push(`OWASP Top 10:2025 ${category.id} ${category.title}`);
  if (finding.cwe) references.push(`CWE ${finding.cwe}`);

  return {
    code: `F-${String(index + 1).padStart(3, "0")}`,
    title: finding.title,
    owasp: finding.owaspTop10
      ? `${finding.owaspTop10} ${getOwaspCategory(finding.owaspTop10)?.title ?? ""}`.trim()
      : "ยังไม่จัดหมวดหมู่",
    goal: wstg
      ? `${wstg.title} — ${wstg.objective}`
      : "ตรวจสอบช่องโหว่ของเว็บแอปพลิเคชันตามมาตรฐาน OWASP WSTG v4.2",
    method: "ทดสอบเว็บแอปพลิเคชันแบบทราบข้อมูลบางส่วน (Grey-Box Web Application Testing)",
    discoveredOn: thaiDate(vulnerability?.createdAt ?? options.generatedAt),
    risk: riskLevel,
    cvssScore: cvss ? String(cvss.score) : undefined,
    cvssVector: cvss?.vector,
    discovered: [
      vulnerability?.description?.trim() || vulnerability?.contextSummary?.trim() || finding.title,
    ],
    steps: vulnerability?.stepsToReproduce ?? [],
    impactDetails,
    recommendations,
    references,
    evidence: maskSensitive((vulnerability?.evidence || "").trim()).slice(0, 2000),
    band: bandFor(riskLevel),
  };
}

const SEVERITY_BANDS: Array<[ThaiLevel, Severity]> = [
  ["วิกฤต", "critical"],
  ["สูง", "high"],
  ["ปานกลาง", "medium"],
  ["ต่ำ", "low"],
  ["ข้อมูลข่าวสาร", "info"],
];

function severityRows(stats: ReportStats): string[][] {
  return SEVERITY_BANDS.map(([level, severity]) => [level, String(stats.bySeverity[severity] ?? 0)]);
}

/** The findings and counts the document is built from — and the model's brief. */
export function reportSummaryInput(options: ReportOptions): {
  sessionName: string;
  findings: ReportFindingsRow[];
  stats: ReportStats;
} {
  const findings = buildReportFindings(options.vulnerabilities ?? []);
  return {
    sessionName: options.session.name,
    findings,
    stats: computeReportStats(findings, options.testPlan),
  };
}

/** The model returns prose, not docx runs: one block per blank line. */
function summaryParagraphs(summary: string): string[] {
  return summary
    .split(/\n\s*\n|\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
}

export function buildClientReport(options: ReportOptions): ClientReport {
  const generatedAt = options.generatedAt ?? new Date();
  const vulnerabilities = options.vulnerabilities ?? [];
  const { findings, stats } = reportSummaryInput(options);
  const byId = new Map(vulnerabilities.map((v) => [v.vulnerabilityId, v]));

  const body: ClientBlock[] = [];

  /* The opening summary is the model's work when it managed to write one. When
     it did not — no provider configured, model unreachable, off-contract reply
     — the document states the counts it already holds, in its own words. */
  const summary = options.summary?.trim();
  if (summary) {
    for (const paragraph of summaryParagraphs(summary)) {
      body.push({ type: "p", text: paragraph });
    }
  } else {
    body.push({
      type: "p",
      text: `รายงานฉบับนี้สรุปช่องโหว่ที่ตรวจพบจากการทดสอบเจาะระบบเว็บแอปพลิเคชัน จำนวน ${stats.totalFindings} รายการ โดยเรียงลำดับจากความเสี่ยงสูงไปต่ำ แต่ละรายการระบุระดับความเสี่ยง คะแนน CVSS v3.0 สิ่งที่ตรวจพบ ผลกระทบ และแนวทางแก้ไข`,
    });
  }

  body.push({
    type: "table",
    headers: ["ระดับความเสี่ยง", "จำนวนช่องโหว่ที่ตรวจพบ"],
    rows: severityRows(stats),
  });

  body.push({ type: "h1", text: "รายละเอียดช่องโหว่ที่ตรวจพบ" });
  if (!findings.length) {
    body.push({ type: "p", text: "ไม่พบช่องโหว่ที่ต้องรายงานจากการทดสอบในขอบเขตที่กำหนด" });
  }
  findings.forEach((finding, index) => {
    body.push({ type: "finding", finding: buildFindingCard(index, finding, byId.get(finding.id), options) });
  });

  return {
    fileName: reportFileName({ ...options, generatedAt }).replace(/\.md$/, ".docx"),
    title: options.title ?? "รายงานช่องโหว่",
    subtitle: `${options.session.name} — สรุปช่องโหว่ที่ตรวจพบ`,
    body,
  };
}

/**
 * The draft: the same document without the model's summary, so the findings can
 * be handed around before the prose is worth reading.
 */
export function buildDraftReport(options: ReportOptions): ClientReport {
  const report = buildClientReport({
    ...options,
    summary: undefined,
    title: "รายงานช่องโหว่ (ฉบับร่าง)",
  });
  return { ...report, fileName: report.fileName.replace(/\.docx$/, "-draft.docx") };
}
