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
 * Structure follows the WSTG v4.2 Reporting guidance (section 5), trimmed to
 * what a draft needs: a single engagement-details block plus disclaimer, the
 * executive summary, scope and methodology, risk and findings summaries,
 * detailed findings, coverage, mapping and recommendations, and the appendices
 * (test-case inventory, risk-rating methodology, glossary). The engagement
 * phases and the report structure come from the WSTG itself; the risk rating is
 * the FIRST CVSS v3.0 base score (the model rates the eight base metrics, the
 * score and severity band are computed here), so the report answers to one
 * guide and one scoring standard.
 */

import {
  WSTG_SOURCE,
  WSTG_VERSION,
  computeOwaspCoverage,
  getOwaspCategory,
  getWstgTest,
} from "../../knowledge";
import type { OwaspTop10Id } from "../../knowledge";
import type {
  SessionVulnerabilityDoc,
  WebAppTestPlanDoc,
} from "../../models/Sessions/Sessions.model";
import { mapFindingToOwaspTop10, normalizeCwe } from "./owasp-mapping.service";
import { computeCoverage, TEST_PLAN_SOURCE } from "./test-plan.service";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
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
  /**
   * The document's opening summary, written by the model (see
   * report-summary.service.ts). Absent when the model could not write one, in
   * which case the report states the counts in its own sentence.
   */
  summary?: string;
  /** Document heading; the draft overrides it. */
  title?: string;
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
  exploited: boolean;
  cwe?: string;
  mappingRationale: string;
  /** Always "official": the classification is a published-list lookup. */
  owaspProvenance?: string;
  /** CVSS v3.0 base score the system computed from the eight rated metrics. */
  cvss?: { score: number; vector: string };
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
 * backfills), so the classification is recomputed here from the finding's CWE
 * every time. The recomputation is a pure lookup in the published lists, so it
 * can never disagree with what was stored.
 */
export function buildReportFindings(
  vulnerabilities: SessionVulnerabilityDoc[],
): ReportFindingsRow[] {
  return [...vulnerabilities].sort(findingSort).map((vulnerability, index) => {
    const wstg = vulnerability.wstgId ? getWstgTest(vulnerability.wstgId) : undefined;
    const mapping = mapFindingToOwaspTop10({ cwe: vulnerability.cwe });

    return {
      id: vulnerability.vulnerabilityId,
      index: index + 1,
      title: vulnerability.title,
      severity: (vulnerability.severity as Severity) ?? "info",
      host: vulnerability.host || "unknown",
      endpoint: vulnerability.endpoint,
      wstgId: wstg?.id ?? vulnerability.wstgId,
      owaspTop10: mapping.primary,
      exploited: !!vulnerability.exploited,
      cwe: normalizeCwe(vulnerability.cwe) || undefined,
      mappingRationale: mapping.rationale,
      owaspProvenance: mapping.provenance,
      cvss: vulnerability.cvss
        ? { score: vulnerability.cvss.score, vector: vulnerability.cvss.vector }
        : undefined,
    };
  });
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
  return parts.length ? parts.join(", ") : "ไม่พบช่องโหว่ที่บันทึกไว้";
}

function owaspTitle(id?: OwaspTop10Id): string {
  if (!id) return "Unmapped";
  return `${id} ${getOwaspCategory(id)?.title ?? ""}`.trim();
}

function introductionSection(options: ReportOptions): string[] {
  const generatedAt = options.generatedAt ?? new Date();
  const rows = [
    `| ลูกค้า | ${tableCell(options.client ?? "ไม่ระบุ")} |`,
    `| เป้าหมาย | ${tableCell(options.target ?? "ไม่ระบุ")} |`,
    `| รูปแบบการทดสอบ | ${tableCell(options.testType ?? "การทดสอบเจาะระบบเว็บแอปพลิเคชันแบบทราบข้อมูลบางส่วน (Grey-box)")} |`,
    `| ช่วงเวลาทดสอบ | ${tableCell(options.testingWindow ?? formatDate(generatedAt))} |`,
    `| ผู้ทดสอบ | ${tableCell(options.tester ?? "ไม่ระบุ")} |`,
    `| ชั้นความลับ | ${tableCell(options.classification ?? "Confidential")} |`,
  ];
  if (options.session.createdAt) {
    rows.push(`| วันที่สร้างเซสชัน | ${formatDate(options.session.createdAt)} |`);
  }
  rows.push(`| วันที่ออกรายงาน | ${formatDate(generatedAt)} |`);
  if (options.version) {
    rows.push(`| เวอร์ชันรายงาน | ${tableCell(options.version)} |`);
  }
  rows.push(
    `| มาตรฐานที่อ้างอิง | OWASP WSTG v${WSTG_VERSION} (วิธีการทดสอบ การให้ระดับความเสี่ยง โครงสร้างรายงาน), OWASP Top 10:2025 (การจัดหมวดความเสี่ยง), CWE (การจำแนกประเภทจุดอ่อน) |`,
  );

  return [
    "## 1. บทนำ",
    "",
    "### 1.1 ข้อมูลการว่าจ้าง",
    "",
    "| หัวข้อ | รายละเอียด |",
    "| --- | --- |",
    ...rows,
    "",
    "### 1.2 ข้อจำกัดความรับผิดชอบ",
    "",
    "การทดสอบนี้เป็นการประเมิน ณ จุดเวลาหนึ่ง สภาพแวดล้อมอาจเปลี่ยนแปลงไปนับตั้งแต่การทดสอบ ไม่มีการรับประกันว่าจะพบปัญหาความปลอดภัยที่เป็นไปได้ทั้งหมด หรือจะไม่มีช่องโหว่ใหม่ที่ถูกค้นพบในภายหลัง รายงานฉบับนี้เป็นเอกสารประกอบการดำเนินงาน ไม่ใช่การรับประกันสภาพของระบบที่ทดสอบ",
    "",
  ];
}

function executiveSummarySection(options: ReportOptions, findings: ReportFindingsRow[], stats: ReportStats): string[] {
  const lines: string[] = ["## 2. บทสรุปผู้บริหาร", ""];
  const urgentCount = stats.bySeverity.critical + stats.bySeverity.high;

  lines.push(
    `การประเมินความปลอดภัยของเว็บแอปพลิเคชัน ${options.target || options.session.name} ดำเนินการตาม OWASP Web Security Testing Guide v${WSTG_VERSION} พบช่องโหว่ด้านความปลอดภัยที่บันทึกไว้ ${stats.totalFindings} รายการ (${severityCountsLine(stats)})`,
  );
  lines.push("");

  if (stats.exploited > 0) {
    lines.push(
      `มีช่องโหว่ ${stats.exploited} รายการที่ถูกใช้ประโยชน์ (exploited) ระหว่างการทดสอบ ซึ่งหมายความว่าผลกระทบได้รับการพิสูจน์แล้ว ไม่ใช่เพียงข้อสันนิษฐาน`,
    );
    lines.push("");
  }

  if (urgentCount > 0) {
    lines.push(
      `การทดสอบครั้งนี้พบประเด็นระดับวิกฤตหรือสูงรวม ${urgentCount} รายการ ควรถือเป็นประเด็นที่ปิดกั้นการปล่อยระบบ (release-blocking) จนกว่าจะแก้ไขหรือยอมรับความเสี่ยงอย่างเป็นทางการ`,
    );
    lines.push("");
  } else if (stats.totalFindings > 0) {
    lines.push(
      "ไม่พบประเด็นระดับวิกฤตหรือสูงภายในขอบเขตที่ทดสอบ ช่องโหว่ที่เหลืออยู่ในระดับปานกลาง ต่ำ หรือข้อมูลข่าวสาร ซึ่งเป็นโอกาสในการเสริมความแข็งแกร่งของระบบ",
    );
    lines.push("");
  }

  const top = findings.slice(0, 5);
  if (top.length) {
    lines.push("**ช่องโหว่หลักที่พบ**", "");
    for (const finding of top) {
      lines.push(
        `- **F-${String(finding.index).padStart(3, "0")} ${finding.title}** (${finding.severity}${finding.cvss ? `, คะแนนฐาน CVSS v3.0 ${finding.cvss.score}` : ""}) — ${finding.host}${finding.endpoint ? ` ${finding.endpoint}` : ""}. ${owaspTitle(finding.owaspTop10)}.`,
      );
    }
    lines.push("");
  }

  lines.push(
    `**ความครอบคลุมการทดสอบ:** ดำเนินการทดสอบตามแผน WSTG แล้ว ${stats.coverage.executed} จาก ${stats.coverage.total} เคส (${stats.coverage.percentExecuted}%) ยังไม่ได้ดำเนินการ ${stats.coverage.notStarted} เคสในรอบนี้ รายการเหล่านี้ปรากฏในหัวข้อ 7 และความเสี่ยงที่เหลืออยู่จากเคสเหล่านั้นยังไม่ได้รับการยืนยัน`,
  );
  lines.push("");

  if (stats.unmapped > 0) {
    lines.push(
      `> มีช่องโหว่ ${stats.unmapped} รายการที่ไม่มี CWE หรือมี CWE ที่ไม่ตรงกับหมวดใดใน OWASP Top 10:2025 จึงรายงานเป็น "Unmapped" ให้บันทึกรหัสจุดอ่อน (CWE) บนช่องโหว่ แล้วหมวดจะตามมาจากรายการทางการเอง`,
    );
    lines.push("");
  }

  lines.push(
    "> บทสรุปผู้บริหารฉบับนี้สร้างจากหลักฐานที่บันทึกไว้ ทุกข้อความต้องได้รับการตรวจสอบเทียบกับรายละเอียดช่องโหว่ก่อนนำส่งรายงาน",
    "",
  );
  return lines;
}

function scopeAndMethodologySection(options: ReportOptions, findings: ReportFindingsRow[]): string[] {
  const hosts = Array.from(new Set(findings.map((finding) => finding.host).filter(Boolean)));
  const lines: string[] = [
    "## 3. ขอบเขต วิธีการทดสอบ และข้อจำกัด",
    "",
    "### 3.1 ขอบเขตการทดสอบ",
    "",
    options.scope || options.target
      ? `${options.scope || options.target}`
      : "ไม่มีการระบุขอบเขตการทดสอบไว้ในเซสชันนี้",
    "",
  ];

  if (hosts.length) {
    lines.push("ทรัพย์สิน (asset) ที่ถูกแตะต้องระหว่างการทดสอบ:", "");
    for (const host of hosts) lines.push(`- ${host}`);
    lines.push("");
  }

  lines.push(
    "### 3.2 วิธีการทดสอบ",
    "",
    `การทดสอบดำเนินตาม OWASP Web Security Testing Guide (WSTG) v${WSTG_VERSION} (${WSTG_SOURCE}) แต่ละเคสที่วางแผนไว้จะมีรหัส WSTG วัตถุประสงค์ วิธีการ และหลักฐานที่คาดหวัง ผลลัพธ์ถูกติดตามเป็นรายเคสด้วยสถานะ passed, failed, blocked, in progress, skipped และ not started`,
    "",
    "การจัดหมวดช่องโหว่เข้ากับ OWASP Top 10:2025 (https://owasp.org/Top10/2025/) ทำจากจุดอ่อนที่ช่องโหว่แต่ละรายการบันทึกไว้ โดยนำรหัส CWE ของช่องโหว่ไปค้นหาในรายการ CWE ที่ OWASP เผยแพร่สำหรับแต่ละหมวด แล้วใช้หมวดที่ตรงกันเพียงหนึ่งเดียว ช่องโหว่ที่ CWE ไม่อยู่ในรายการที่เผยแพร่ หรือไม่ได้บันทึก CWE จะรายงานเป็น Unmapped แทนการบังคับจัดเข้าหมวด การจัดหมวดนี้เป็นแบบกำหนดแน่นอน (deterministic) ไม่ใช้ฮิวริสติก ไม่ใช้ตารางเทียบที่ดูแลด้วยมือ และไม่ใช้โมเดล โดยช่องโหว่แต่ละรายการจะระบุ CWE ที่ใช้จัดหมวด",
    "",
  );

  if (options.tools?.length) {
    lines.push(`เครื่องมือและเทคนิคที่ใช้: ${options.tools.join(", ")}.`, "");
  }

  if (options.engagementNotes) {
    lines.push("### 3.3 บันทึกการว่าจ้าง", "", options.engagementNotes, "");
  }

  lines.push(
    `### ${options.engagementNotes ? "3.4" : "3.3"} สมมติฐานและข้อจำกัด`,
    "",
    options.limitations ||
      "ช่องโหว่ที่รายงานจำกัดอยู่ที่ขอบเขต ข้อมูลรับรอง และช่วงเวลาที่มีสำหรับการประเมินครั้งนี้ เคสที่ยังไม่ได้ทดสอบหรือถูกบล็อกจะบันทึกไว้ในหัวข้อ 7 และถือเป็นความเสี่ยงที่ยังไม่ได้รับการยืนยัน มิใช่การยืนยันว่าไม่มีช่องโหว่",
    "",
  );

  return lines;
}

function riskSummarySection(findings: ReportFindingsRow[], stats: ReportStats): string[] {
  const lines: string[] = [
    "## 4. สรุปความเสี่ยง",
    "",
    "### 4.1 ช่องโหว่จำแนกตามระดับความรุนแรง",
    "",
    "| ระดับความรุนแรง | จำนวนช่องโหว่ | ถูกใช้ประโยชน์ |",
    "| --- | --- | --- |",
  ];
  for (const severity of SEVERITY_ORDER) {
    const rows = findings.filter((finding) => finding.severity === severity);
    lines.push(
      `| ${severity} | ${rows.length} | ${rows.filter((row) => row.exploited).length} |`,
    );
  }
  lines.push(`| **รวม** | **${stats.totalFindings}** | **${stats.exploited}** |`, "");

  lines.push(
    "### 4.2 ช่องโหว่จำแนกตามหมวด OWASP Top 10:2025",
    "",
    "| OWASP Top 10:2025 | หมวด | จำนวนช่องโหว่ |",
    "| --- | --- | --- |",
  );
  for (const category of stats.byOwasp) {
    lines.push(`| ${category.id} | ${category.title} | ${category.findings} |`);
  }
  if (stats.unmapped > 0) {
    lines.push(`| — | Unmapped (ต้องจัดหมวดด้วยมือ) | ${stats.unmapped} |`);
  }
  lines.push("");
  return lines;
}

function findingsSummarySection(findings: ReportFindingsRow[]): string[] {
  const lines: string[] = [
    "## 5. สรุปช่องโหว่ที่พบ",
    "",
    "| รหัส | ระดับความรุนแรง | CVSS v3.0 | ชื่อช่องโหว่ | ทรัพย์สินที่กระทบ | WSTG | OWASP Top 10:2025 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  if (!findings.length) {
    lines.push("| — | — | — | ไม่พบช่องโหว่ที่บันทึกไว้ในเซสชันนี้ | — | — | — |");
  }
  for (const finding of findings) {
    lines.push(
      `| F-${String(finding.index).padStart(3, "0")} | ${finding.severity}${finding.exploited ? " (exploited)" : ""} | ${finding.cvss ? `${finding.cvss.score}` : "—"} | ${tableCell(finding.title)} | ${tableCell(finding.host)}${finding.endpoint ? `<br>${tableCell(finding.endpoint)}` : ""} | ${finding.wstgId ?? "—"} | ${owaspTitle(finding.owaspTop10)} |`,
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
  const lines: string[] = [
    "## 6. รายละเอียดช่องโหว่ที่ตรวจพบ",
    "",
    "*หลักฐานด้านล่างถูกปิดบังข้อมูลอ่อนไหว (รหัสผ่าน โทเคน คีย์ และตัวเลขที่คล้ายเลขบัตร) ก่อนเข้าสู่รายงาน (ตามคำแนะนำด้านการรายงานของ WSTG: ให้ปิดบังข้อมูลอ่อนไหว) โปรดตรวจสอบการปิดบังอีกครั้งก่อนนำส่ง*",
    "",
  ];

  if (!findings.length) {
    lines.push(
      "ไม่พบช่องโหว่ที่บันทึกไว้ระหว่างการทดสอบครั้งนี้ ความครอบคลุมในหัวข้อ 7 แสดงว่าเคสทดสอบใดสนับสนุนข้อสรุปนี้",
      "",
    );
    return lines;
  }

  for (const finding of findings) {
    const vulnerability = byId.get(finding.id);
    const wstg = finding.wstgId ? getWstgTest(finding.wstgId) : undefined;
    const category = getOwaspCategory(finding.owaspTop10);

    lines.push(`### 6.${finding.index} F-${String(finding.index).padStart(3, "0")} — ${finding.title}`, "");
    lines.push("| หัวข้อ | รายละเอียด |", "| --- | --- |");
    lines.push(`| ระดับความรุนแรง | ${finding.severity}${finding.exploited ? " (exploited)" : ""} |`);

    lines.push(`| ทรัพย์สินที่กระทบ | ${tableCell(finding.host)}${finding.endpoint ? ` — ${tableCell(finding.endpoint)}` : vulnerability?.service ? ` — ${tableCell(vulnerability.service)}` : ""} |`);
    lines.push(`| CWE | ${finding.cwe ?? "ไม่ได้บันทึก"} |`);
    // The score was computed from the eight CVSS v3.0 base metrics; see
    // Appendix B for the methodology.
    lines.push(
      `| คะแนนฐาน CVSS v3.0 | ${finding.cvss ? `${finding.cvss.score} (${finding.severity})` : "ไม่ได้ประเมิน"} |`,
      `| เวกเตอร์ CVSS | ${finding.cvss ? tableCell(finding.cvss.vector) : "ไม่ได้ประเมิน — ต้องบันทึกเมทริกฐานทั้งแปดตัว"} |`,
    );
    if (vulnerability?.cve) lines.push(`| CVE | ${tableCell(vulnerability.cve)} |`);
    lines.push(`| OWASP Top 10:2025 | ${owaspTitle(finding.owaspTop10)} |`);
    lines.push(`| เกณฑ์การจัดหมวด | ${tableCell(finding.mappingRationale)} |`);
    lines.push(
      `| อ้างอิง WSTG v${WSTG_VERSION} | ${wstg ? `${wstg.id} (${wstg.section}) ${wstg.title}` : finding.wstgId ?? "ยังไม่ได้เชื่อมโยงเคสทดสอบ WSTG — ให้เชื่อมช่องโหว่กับเคสที่ทำให้พบ"} |`,
    );
    lines.push("");

    lines.push("**คำอธิบาย**", "");
    lines.push(
      vulnerability?.description || vulnerability?.contextSummary || "ไม่ได้บันทึกคำอธิบายสำหรับช่องโหว่นี้",
      "",
    );

    if (vulnerability?.contextSummary && vulnerability.contextSummary !== vulnerability.description) {
      lines.push("**บริบท**", "", vulnerability.contextSummary, "");
    }

    if (wstg) {
      lines.push("**วิธีการทดสอบ (ตาม WSTG)**", "", `${wstg.objective} ${wstg.howToTest}`, "");
    }

    lines.push("**หลักฐาน**", "");
    lines.push("```text");
    lines.push(maskSensitive((vulnerability?.evidence || "ไม่ได้เก็บหลักฐานดิบไว้").trim()));
    lines.push("```", "");

    if (vulnerability?.stepsToReproduce?.length) {
      lines.push("**ขั้นตอนการทำซ้ำ**", "");
      vulnerability.stepsToReproduce.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
      lines.push("");
    }

    lines.push("**ผลกระทบ**", "", vulnerability?.impact || "ไม่ได้บันทึกผลกระทบ ต้องประเมินและเติมให้ครบก่อนนำส่ง", "");
    lines.push(
      "**แนวทางแก้ไข**",
      "",
      vulnerability?.remediation || category?.remediation.map((item) => `- ${item}`).join("\n") || "ไม่ได้บันทึกแนวทางแก้ไข",
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
        "- OWASP mapping provenance: official (รายการ CWE ที่ OWASP เผยแพร่สำหรับหมวดนี้ " +
          "https://owasp.org/Top10/2025/)",
      );
    }
    if (references.length) lines.push("**เอกสารอ้างอิง**", "", ...references, "");
  }

  return lines;
}

function wstgCoverageSection(plan?: WebAppTestPlanDoc | null): string[] {
  const lines: string[] = ["## 7. ความครอบคลุมการทดสอบตาม WSTG v" + WSTG_VERSION, ""];

  if (!plan || !plan.cases?.length) {
    lines.push(
      "ไม่มีการบันทึกแผนการทดสอบ WSTG สำหรับเซสชันนี้ จึงไม่สามารถแสดงหลักฐานความครอบคลุมได้ ให้สร้างแผนด้วยเครื่องมือ wstg_test_plan แล้วรันการประเมินใหม่เพื่อให้ได้รายงานที่อ้างอิงความครอบคลุมได้",
      "",
    );
    return lines;
  }

  const coverage = computeCoverage(plan.cases);
  lines.push(
    `แหล่งที่มาของแผน: ${TEST_PLAN_SOURCE}, สร้างเมื่อ ${formatDate(plan.createdAt)} ดำเนินการแล้ว ${coverage.executed}/${coverage.total} เคส (${coverage.percentExecuted}%): passed ${coverage.passed}, failed ${coverage.failed}, blocked ${coverage.blocked}, in progress ${coverage.inProgress}, skipped ${coverage.skipped}, not started ${coverage.notStarted}`,
    "",
    "| หมวด WSTG | หมวด | วางแผน | ดำเนินการ | passed | failed | blocked |",
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
    lines.push("### 7.1 เคสทดสอบที่ทำให้พบช่องโหว่", "");
    for (const testCase of failed) {
      lines.push(
        `- ${testCase.testId} (${testCase.section}) ${testCase.title}; ช่องโหว่ที่เชื่อมโยง: ${testCase.linkedVulnerabilityIds?.length ? testCase.linkedVulnerabilityIds.join(", ") : "ไม่มีที่บันทึกไว้"}`,
      );
    }
    lines.push("");
  }

  const blocked = plan.cases.filter((testCase) => testCase.status === "blocked");
  if (blocked.length) {
    lines.push("### 7.2 เคสทดสอบที่ถูกบล็อก", "");
    for (const testCase of blocked) {
      lines.push(`- ${testCase.testId} ${testCase.title} — ${testCase.notes || "ไม่ได้บันทึกเหตุผล"}`);
    }
    lines.push("");
  }

  const notStarted = plan.cases.filter((testCase) => testCase.status === "not_started");
  if (notStarted.length) {
    lines.push("### 7.3 ยังไม่ได้ทดสอบ (ความเสี่ยงที่เหลืออยู่)", "");
    lines.push(
      "เคสทดสอบที่วางแผนไว้ดังต่อไปนี้ยังไม่ได้ดำเนินการ ถือเป็นความเสี่ยงที่ยังไม่ได้รับการยืนยัน ไม่ใช่ผลลัพธ์เชิงลบ:",
      "",
    );
    for (const testCase of notStarted.slice(0, 60)) {
      lines.push(`- ${testCase.testId} (${testCase.section}) ${testCase.title}`);
    }
    if (notStarted.length > 60) {
      lines.push(`- ...และอีก ${notStarted.length - 60} เคสที่เหลืออยู่ในแผนการทดสอบของเซสชัน`);
    }
    lines.push("");
  }

  return lines;
}

function owaspMappingSection(stats: ReportStats): string[] {
  const lines: string[] = [
    "## 8. การจัดหมวดตาม OWASP Top 10:2025",
    "",
    "การจัดหมวดตาม OWASP Top 10:2025 บันทึกไว้บนช่องโหว่แต่ละรายการเอง (หัวข้อ 6) และนับแยกตามหมวดในหัวข้อ 4.2 ทุกการจัดหมวดคือการนำ CWE ของช่องโหว่ไปค้นหาในรายการ CWE ที่ OWASP เผยแพร่สำหรับหมวดปี 2025 — ไม่มีการอนุมาน และไม่ใช้โมเดล ช่องโหว่ที่ไม่มี CWE หรือมี CWE ที่ไม่อยู่ในรายการที่เผยแพร่ จะรายงานเป็น \"Unmapped\" แทนการบังคับจัดเข้าหมวด หมวดที่ไม่มีช่องโหว่จะไม่แสดงในที่นี้",
    "",
  ];

  const affected = stats.byOwasp.filter((entry) => entry.findings > 0);
  if (affected.length) {
    lines.push("แนวทางระดับโครงการสำหรับหมวดที่พบ:", "");
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
  const lines: string[] = ["## 9. ข้อเสนอแนะ", ""];
  const label = (finding: ReportFindingsRow) =>
    `**F-${String(finding.index).padStart(3, "0")} ${finding.title}** (${finding.host}${finding.endpoint ? ` ${finding.endpoint}` : ""})`;
  const remediation = (finding: ReportFindingsRow) =>
    byId.get(finding.id)?.remediation || "ไม่ได้บันทึกแนวทางแก้ไข — ต้องกำหนดก่อนนำส่ง";

  const groups: Array<{ title: string; severities: Severity[] }> = [
    { title: "### 9.1 เร่งด่วน (ภายใน 7 วัน)", severities: ["critical", "high"] },
    { title: "### 9.2 ระยะสั้น (ภายใน 30 วัน)", severities: ["medium"] },
    { title: "### 9.3 งานเสริมความแข็งแกร่ง (รอบการปล่อยถัดไป)", severities: ["low", "info"] },
  ];

  for (const group of groups) {
    lines.push(group.title, "");
    const rows = findings.filter((finding) => group.severities.includes(finding.severity));
    if (!rows.length) {
      lines.push(
        group.severities.includes("critical")
          ? "- ไม่มีช่องโหว่ระดับวิกฤตหรือสูงที่ค้างอยู่"
          : "- ไม่มีรายการค้างในระดับนี้",
      );
    }
    for (const finding of rows) {
      lines.push(`- ${label(finding)}: ${remediation(finding)}`);
    }
    lines.push("");
  }

  lines.push("### 9.4 ข้อเสนอแนะด้านกระบวนการ", "");
  lines.push(
    "- รันแผนการทดสอบ WSTG v" + WSTG_VERSION + " ซ้ำหลังการแก้ไข และแนบตารางความครอบคลุมที่อัปเดตไว้กับรายงานเวอร์ชันถัดไป",
  );
  lines.push(
    "- ปิดเคสที่ยังไม่ได้ทดสอบในหัวข้อ 7.3 ในการทดสอบรอบถัดไป เคสเหล่านี้เป็นความเสี่ยงที่ยังไม่ได้รับการยืนยัน ไม่ใช่ผลลัพธ์ที่สะอาด",
  );
  lines.push(
    "- เก็บบันทึกการจัดหมวด OWASP Top 10:2025 ไว้บนทุกช่องโหว่ที่ติดตาม เพื่อให้การรายงานความเสี่ยงเปรียบเทียบกันได้ข้ามเวอร์ชัน",
  );
  lines.push("");
  return lines;
}

function appendixSection(plan?: WebAppTestPlanDoc | null): string[] {
  const lines: string[] = ["## 10. ภาคผนวก A — รายการเคสทดสอบ", ""];

  if (!plan?.cases?.length) {
    lines.push("ไม่มีการบันทึกแผนการทดสอบสำหรับเซสชันนี้", "");
  } else {
    lines.push(
      "| รหัส WSTG | หมวด | เคสทดสอบ | สถานะ | ข้อสังเกต | ช่องโหว่ที่เชื่อมโยง |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const testCase of plan.cases) {
      lines.push(
        `| ${testCase.testId} | ${testCase.section} | ${tableCell(testCase.title)} | ${testCase.status} | ${tableCell(truncateText(testCase.observations || testCase.notes, 120))} | ${testCase.linkedVulnerabilityIds?.length ? testCase.linkedVulnerabilityIds.join(", ") : "—"} |`,
      );
    }
    lines.push("");
    lines.push(
      "รายการนี้คือเช็กลิสต์ WSTG v4.2 สำหรับการว่าจ้างครั้งนี้ เช็กลิสต์ทางการอยู่ที่ https://github.com/OWASP/wstg/tree/master/checklist ความครอบคลุมวัดจากเคสที่อยู่ในขอบเขต และเคสที่ไม่สามารถนำมาใช้ได้จะบันทึกเป็น blocked ไม่นับเป็น passed ในการทดสอบซ้ำ ให้เทียบแต่ละเคสกับผลการรันครั้งก่อนหน้าและสรุปสิ่งที่เปลี่ยนแปลง",
      "",
    );
  }

  lines.push(
    "## 11. ภาคผนวก B - วิธีการให้ระดับความเสี่ยง (CVSS v3.0)",
    "",
    "การว่าจ้างครั้งนี้ดำเนินตามคำแนะนำด้านการรายงานของ WSTG (OWASP WSTG v" + WSTG_VERSION + ") ว่าช่องโหว่ต้องบันทึกอะไร ส่วนการให้ระดับความรุนแรงใช้ Common Vulnerability Scoring System เวอร์ชัน 3.0 ตามที่ FIRST เผยแพร่ ผู้ทดสอบให้คะแนนเมทริกฐานทั้งแปดตัว — Attack Vector (AV), Attack Complexity (AC), Privileges Required (PR), User Interaction (UI), Scope (S), Confidentiality (C), Integrity (I) และ Availability (A) — แล้วคะแนนฐานคำนวณจากเมทริกเหล่านั้นด้วยสมการของ FIRST จะไม่ยอมรับคำบอกระดับความรุนแรงที่ระบุมาลอย ๆ ระดับความรุนแรงจะตามมาจากคะแนนที่คำนวณได้เสมอ ใช้เฉพาะกลุ่ม Base Score เท่านั้น ส่วน Temporal และ Environmental อยู่นอกขอบเขตของรายงานฉบับนี้",
    "",
    "| เมทริก | ค่า |",
    "| --- | --- |",
    "| Attack Vector (AV) | Network (N), Adjacent (A), Local (L), Physical (P) |",
    "| Attack Complexity (AC) | Low (L), High (H) |",
    "| Privileges Required (PR) | None (N), Low (L), High (H) |",
    "| User Interaction (UI) | None (N), Required (R) |",
    "| Scope (S) | Unchanged (U), Changed (C) |",
    "| Confidentiality (C) | None (N), Low (L), High (H) |",
    "| Integrity (I) | None (N), Low (L), High (H) |",
    "| Availability (A) | None (N), Low (L), High (H) |",
    "",
    "สตริงเวกเตอร์ที่บันทึกไว้บนช่องโหว่แต่ละรายการ (ตัวอย่าง `CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`) ทำให้ทุกการให้คะแนนสามารถทำซ้ำได้: การนำไปกรอกในเครื่องคิดเลขทางการที่ https://www.first.org/cvss/calculator/3.0 จะได้คะแนนและระดับความรุนแรงตรงกับที่พิมพ์ในรายงานฉบับนี้",
    "",
    "| คะแนนฐาน | ระดับความรุนแรงเชิงคุณภาพ |",
    "| --- | --- |",
    "| 0.0 | None — บันทึกเป็น Informational |",
    "| 0.1 – 3.9 | Low |",
    "| 4.0 – 6.9 | Medium |",
    "| 7.0 – 8.9 | High |",
    "| 9.0 – 10.0 | Critical |",
    "",
    "| ระดับความรุนแรง | การตอบสนอง |",
    "| --- | --- |",
    "| Critical | แก้ไขโดยเร่งด่วน นอกวงรอบปกติ ปฏิบัติเสมือนเป็นความเสี่ยงที่เปิดอยู่จนกว่าจะแก้ไข |",
    "| High | แก้ไขโดยเร่งด่วนในวงรอบปัจจุบัน ปฏิบัติเสมือนเป็นความเสี่ยงที่เปิดอยู่จนกว่าจะแก้ไข |",
    "| Medium | แก้ไขในวงรอบที่วางแผนไว้ |",
    "| Low | เสริมความแข็งแกร่งเมื่อมีโอกาส |",
    "| Informational | ไม่ต้องดำเนินการ บันทึกไว้เพื่อความครบถ้วน |",
    "",
    "## 12. ภาคผนวก C - คำย่อและเอกสารอ้างอิง",
    "",
    "| คำย่อ | ความหมาย |",
    "| --- | --- |",
    "| WSTG | OWASP Web Security Testing Guide — วิธีการทดสอบที่ใช้ในรายงานฉบับนี้ |",
    "| WSTG ID | รหัสของเคสทดสอบ WSTG หนึ่งรายการ เช่น WSTG-INPV-05 |",
    "| OWASP Top 10:2025 | รายการตระหนักรู้สิบความเสี่ยงความปลอดภัยของเว็บแอปพลิเคชันที่สำคัญที่สุดของ OWASP ประจำปี 2025 |",
    "| CVSS v3.0 | Common Vulnerability Scoring System เวอร์ชัน 3.0 (FIRST) — คะแนนฐานที่ใช้คำนวณระดับความรุนแรงของแต่ละช่องโหว่ |",
    "| CWE | Common Weakness Enumeration — รหัสจำแนกประเภทจุดอ่อนที่เป็นต้นเหตุ |",
    "| IDOR | Insecure Direct Object Reference — การเข้าถึงออบเจกต์โดยการดัดแปลงตัวระบุ |",
    "| SSRF | Server-Side Request Forgery — เซิร์ฟเวอร์ดึง URL ที่ผู้โจมตีควบคุม |",
    "| CSRF | Cross-Site Request Forgery — การบังคับเปลี่ยนสถานะผ่านเซสชันของเหยื่อ |",
    "",
    "**เอกสารอ้างอิง**",
    "",
    `- OWASP Web Security Testing Guide v${WSTG_VERSION}: ${WSTG_SOURCE}`,
    "- OWASP Top 10:2025: https://owasp.org/Top10/2025/",
    "- OWASP WSTG v4.2 Reporting guidance: https://wstg.owasp.org/v4.2/5-Reporting/",
    "- CVSS v3.0 specification: https://www.first.org/cvss/v3.0/specification-document",
    "- CVSS v3.0 calculator: https://www.first.org/cvss/calculator/3.0",
    "- CWE: https://cwe.mitre.org/",
    "",
    "---",
    "",
    "*ฉบับร่างนี้สร้างโดยผู้ช่วยจากหลักฐานในเซสชัน แผนการทดสอบ WSTG ของเซสชัน และการจัดหมวด OWASP Top 10:2025 โปรดตรวจสอบทุกหัวข้อ เติมส่วนที่ระบุว่ายังไม่ได้บันทึกให้ครบ และลบหมายเหตุนี้ก่อนนำส่งรายงาน*",
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
  const title = `${options.session.name} — รายงานการทดสอบเจาะระบบเว็บแอปพลิเคชัน (ฉบับร่าง)`;

  // The major sections, each preceded by a rule so the rendered draft has
  // visible rhythm between chapters rather than one unbroken column of text.
  const sections: string[][] = [
    introductionSection(resolved),
    executiveSummarySection(resolved, findings, stats),
    scopeAndMethodologySection(resolved, findings),
    riskSummarySection(findings, stats),
    findingsSummarySection(findings),
    detailedFindingsSection(findings, vulnerabilities),
    wstgCoverageSection(options.testPlan),
    owaspMappingSection(stats),
    recommendationsSection(findings, vulnerabilities),
    appendixSection(options.testPlan),
  ];

  const markdown = [
    `# ${title}`,
    "",
    `*ฉบับร่างสร้างเมื่อ ${formatDate(generatedAt)} จากหลักฐานในเซสชัน โดยใช้ ${TEST_PLAN_SOURCE} และ OWASP Top 10:2025 โปรดตรวจสอบก่อนนำส่ง*`,
    "",
    ...sections.flatMap((section) => ["---", "", ...section]),
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
