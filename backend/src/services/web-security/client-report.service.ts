/**
 * Thai client-facing report builder.
 *
 * Turns the same session evidence the internal draft uses into the structure a
 * client deliverable follows (cover, document details, abbreviations, document
 * history, tester list, usage terms, TOC, rationale/objectives, methodology
 * with rating criteria tables, executive summary, and one card per finding
 * with a coloured severity band). The output is a typed block list so the
 * frontend preview and the .docx exporter render the same document from one
 * source. Engineering-only metadata (mapping provenance, classification
 * basis, coverage bookkeeping) is deliberately kept out of this document.
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

export interface ClientReportFrontMatter {
  cover: { titleLines: string[]; preparedBy: string; client: string };
  documentDetails: [string, string][];
  abbreviations: [string, string][];
  history: string[][];
  testers: { name: string; position: string; role: string; email: string; phone: string }[];
  terms: string;
  footerLine: string;
}

export interface ClientReport {
  fileName: string;
  frontMatter: ClientReportFrontMatter;
  toc: string[];
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
      `ช่องโหว่นี้อาจส่งผลต่อความลับของข้อมูล ความถูกต้องของระบบ หรือการให้บริการของ ${options.client || "ผู้ว่าจ้าง"} ผู้ประเมินควรประเมินผลกระทบเชิงธุรกิจเพิ่มเติมก่อนนำส่ง`,
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

export function buildClientReport(options: ReportOptions): ClientReport {
  const generatedAt = options.generatedAt ?? new Date();
  const vulnerabilities = options.vulnerabilities ?? [];
  const findings = buildReportFindings(vulnerabilities);
  const stats = computeReportStats(findings, options.testPlan);
  const byId = new Map(vulnerabilities.map((v) => [v.vulnerabilityId, v]));
  const client = options.client || "ผู้ว่าจ้าง";
  const tester = options.tester || "";

  const severityRows = (["วิกฤต", "สูง", "ปานกลาง", "ต่ำ", "ข้อมูลข่าวสาร"] as ThaiLevel[]).map((level) => {
    const severity: Severity =
      level === "วิกฤต"
        ? "critical"
        : level === "สูง"
          ? "high"
          : level === "ปานกลาง"
            ? "medium"
            : level === "ต่ำ"
              ? "low"
              : "info";
    return [level, String(stats.bySeverity[severity] ?? 0)];
  });

  const body: ClientBlock[] = [];

  body.push({ type: "h1", text: "1. หลักการและเหตุผล" });
  body.push({
    type: "p",
    text: `${client} ได้เล็งเห็นความสำคัญของการรักษาความมั่นคงปลอดภัยของระบบสารสนเทศ โดยเฉพาะเว็บแอปพลิเคชันที่ให้บริการผ่านเครือข่ายอินเทอร์เน็ต${
      options.target ? ` (${options.target})` : ""
    } ซึ่งเป็นช่องทางที่ผู้ไม่หวังดีสามารถเข้าถึงได้จากภายนอกองค์กร การมีช่องโหว่ที่ไม่ได้รับการตรวจสอบและแก้ไขอาจก่อให้เกิดความเสียหายทั้งด้านข้อมูล ด้านการเงิน และด้านชื่อเสียงขององค์กร จึงจำเป็นต้องยกระดับการรักษาความมั่นคงปลอดภัยของระบบอย่างเป็นระบบ`,
  });
  body.push({
    type: "p",
    text: `รายงานฉบับนี้สรุปผลการทดสอบเจาะระบบเว็บแอปพลิเคชันของ ${client} โดยทีมผู้ทดสอบปฏิบัติงานตามมาตรฐาน OWASP Web Security Testing Guide (WSTG) v4.2 และจัดระดับความเสี่ยงของช่องโหว่ที่พบด้วยคะแนนฐาน CVSS v3.0 ของ FIRST เพื่อให้ ${client} สามารถนำผลไปใช้วางลำดับความสำคัญในการแก้ไขและปรับปรุงความมั่นคงปลอดภัยของระบบได้อย่างมีประสิทธิภาพ`,
  });

  body.push({ type: "h1", text: "2. วัตถุประสงค์" });
  body.push({
    type: "p",
    text: `การทดสอบครั้งนี้มีวัตถุประสงค์เพื่อประเมินความมั่นคงปลอดภัยของเว็บแอปพลิเคชันของ ${client} โดยจำลองการโจมตีจากมุมมองของผู้บุกรุก ภายใต้ขอบเขตและเงื่อนไขที่ได้รับอนุญาต เพื่อค้นหาจุดอ่อนและช่องโหว่ที่อาจก่อให้เกิดความเสียหายต่อข้อมูลสารสนเทศ และเสนอแนวทางแก้ไขเพื่อให้องค์กรสามารถบริหารจัดการความเสี่ยงได้อย่างมีประสิทธิภาพ`,
  });

  body.push({ type: "h1", text: "3. เป้าหมายของโครงการ" });
  body.push({
    type: "numbers",
    items: [
      "เพื่อให้ทราบถึงจุดอ่อนหรือช่องโหว่ของเว็บแอปพลิเคชันและระบบให้บริการที่อยู่ในขอบเขตการทดสอบ",
      "เพื่อนำเสนอช่องโหว่ที่ตรวจพบพร้อมระดับความเสี่ยงและแนวทางแก้ไข ต่อผู้ดูแลระบบและผู้บริหาร เพื่อดำเนินการปรับปรุงและยกระดับความมั่นคงปลอดภัยของระบบ",
    ],
  });

  body.push({ type: "h1", text: "4. บทนำ" });
  body.push({
    type: "p",
    text: `การทดสอบเจาะระบบครั้งนี้เป็นการจำลองสถานการณ์การโจมตีระบบสารสนเทศโดยทีมผู้ทดสอบทราบข้อมูลบางส่วนเกี่ยวกับระบบที่ทดสอบ (Grey-Box) เพื่อตรวจสอบความแข็งแรงของมาตรการรักษาความปลอดภัย ทั้งนี้ผลการทดสอบเป็นผลจากการประเมินในช่วงเวลาหนึ่ง ไม่ได้หมายความว่าหากดำเนินการตามคำแนะนำครบถ้วนแล้วระบบจะปลอดภัยต่อภัยคุกคามทุกรูปแบบอย่างต่อเนื่อง ที่ปรึกษาจึงแนะนำให้ตรวจสอบเป็นประจำทุกปี หรือเมื่อมีการเปลี่ยนแปลงระบบสารสนเทศที่สำคัญ`,
  });

  body.push({ type: "h2", text: "4.1 แนวทางในการดำเนินงาน" });
  body.push({ type: "bullets", items: [
    "การวางแผนการดำเนินงาน (Planning) — กำหนดขอบเขต เป้าหมาย และเงื่อนไขการทดสอบร่วมกับผู้ว่าจ้าง",
    "การรวบรวมข้อมูล (Information Gathering) — ค้นหาและรวบรวมข้อมูลของระบบเป้าหมายที่เปิดเผยต่อสาธารณะ",
    "การค้นหาช่องโหว่ (Vulnerability Analysis) — ตรวจสอบช่องโหว่ของเว็บแอปพลิเคชันตามมาตรฐาน OWASP WSTG v4.2 ครอบคลุมด้านการพิสูจน์ตัวตน การควบคุมสิทธิ์ การจัดการเซสชัน การตรวจสอบข้อมูลนำเข้า การเปิดเผยข้อมูล และการจัดการข้อผิดพลาด",
    "การทดสอบเจาะระบบ (Penetration Test) — พิสูจน์ช่องโหว่ที่พบด้วยการโจมตีจริงภายใต้ขอบเขตที่ได้รับอนุญาต เพื่อแสดงผลกระทบที่เกิดขึ้นได้จริง",
  ] });

  body.push({ type: "h2", text: "4.2 ระยะเวลาในการดำเนินงาน" });
  body.push({ type: "p", text: options.testingWindow ? `ดำเนินการทดสอบภายในช่วงเวลา ${options.testingWindow}` : `ดำเนินการทดสอบ ณ ${thaiDate(options.session.createdAt ?? generatedAt)}` });

  body.push({ type: "h2", text: "4.3 เป้าหมายและจุดมุ่งหมายในการทดสอบ" });
  body.push({ type: "table", headers: ["ระบบที่ทำการทดสอบ", "ขอบเขต"], rows: [[options.target || options.session.name, options.scope || "เว็บแอปพลิเคชันที่ระบุในขอบเขตการทดสอบ"]] });

  const assets = Array.from(new Set(findings.map((f) => f.host).filter(Boolean)));
  if (assets.length) {
    body.push({ type: "h2", text: "4.4 ระบบเป้าหมายที่ใช้ในการทดสอบเจาะระบบ" });
    body.push({ type: "table", headers: ["ลำดับ", "ระบบ/โฮสต์ที่ทดสอบ"], rows: assets.map((host, i) => [String(i + 1), host]) });
  }

  body.push({ type: "h2", text: "4.5 เครื่องมือที่ใช้ในการทดสอบ" });
  body.push({ type: "bullets", items: options.tools?.length ? options.tools : [
    "Burp Suite — ตรวจสอบและแก้ไขการสื่อสารระหว่างผู้ใช้งานกับเว็บแอปพลิเคชัน",
    "OWASP ZAP — สแกนช่องโหว่เว็บแอปพลิเคชัน",
    "Nmap — สแกนพอร์ตและบริการที่เปิดใช้งาน",
    "เว็บเบราว์เซอร์อัตโนมัติ (Chromium) และสคริปต์ทดสอบที่พัฒนาขึ้นภายใน",
  ] });

  body.push({ type: "h2", text: "4.6 เกณฑ์การให้ระดับความเสี่ยง (CVSS v3.0)" });
  body.push({
    type: "p",
    text: "ระดับความเสี่ยงของแต่ละช่องโหว่ได้จากคะแนนฐาน (Base Score) ของ Common Vulnerability Scoring System เวอร์ชัน 3.0 (CVSS v3.0) ที่เผยแพร่โดย FIRST ผู้ทดสอบประเมินตัวชี้วัดพื้นฐานทั้งแปดด้าน ได้แก่ เวกเตอร์การโจมตี (AV) ความซับซ้อนของการโจมตี (AC) สิทธิ์ที่ต้องใช้ (PR) การมีส่วนร่วมของผู้ใช้ (UI) ขอบเขต (S) ผลกระทบต่อความลับของข้อมูล (C) ความถูกต้องของข้อมูล (I) และการให้บริการ (A) แล้วระบบคำนวณคะแนนจากสูตรมาตรฐานของ FIRST โดยคะแนนเต็ม 10.0 แปลงเป็นระดับความเสี่ยงตามตารางดังนี้",
  });
  body.push({
    type: "table",
    headers: ["คะแนนฐาน CVSS v3.0", "ระดับความเสี่ยง"],
    rows: [
      ["0.0", "ข้อมูลข่าวสาร (None)"],
      ["0.1 – 3.9", "ต่ำ (Low)"],
      ["4.0 – 6.9", "ปานกลาง (Medium)"],
      ["7.0 – 8.9", "สูง (High)"],
      ["9.0 – 10.0", "วิกฤต (Critical)"],
    ],
  });
  body.push({
    type: "p",
    text: "สามารถตรวจสอบคะแนนของแต่ละช่องโหว่ย้อนกลับได้จากเวกเตอร์ CVSS ที่ระบุในรายละเอียดช่องโหว่ ผ่านเครื่องคำนวณอย่างเป็นทางการที่ https://www.first.org/cvss/calculator/3.0",
  });

  body.push({ type: "h2", text: "4.7 ข้อมูลเพิ่มเติม — OWASP Top 10:2025" });
  const present = stats.byOwasp.filter((entry) => entry.findings > 0);
  body.push({
    type: "p",
    text: "OWASP Top 10:2025 คือรายการช่องโหว่ที่ร้ายแรงและพบมากที่สุดของเว็บแอปพลิเคชัน จัดทำโดย OWASP (Open Worldwide Application Security Project) รายงานฉบับนี้จัดหมวดหมู่ช่องโหว่ที่ตรวจพบตามรายการดังกล่าว โดยหมวดที่พบในการทดสอบครั้งนี้มีดังนี้",
  });
  body.push({
    type: "table",
    headers: ["รหัส", "หมวดช่องโหว่", "จำนวนที่พบ"],
    rows: present.map((entry) => [entry.id, entry.title, String(entry.findings)]),
  });

  body.push({ type: "h1", text: "5. บทสรุปสำหรับผู้บริหาร" });
  body.push({
    type: "p",
    text: `ผลการทดสอบเจาะระบบเว็บแอปพลิเคชันของ ${client} พบช่องโหว่รวม ${stats.totalFindings} รายการ${
      stats.exploited > 0 ? ` ในจำนวนนี้ ${stats.exploited} รายการได้รับการพิสูจน์ว่าโจมตีได้จริง` : ""
    } โดยแบ่งตามระดับความเสี่ยงดังตาราง และได้ทดสอบตามแผน ${stats.coverage.executed} จาก ${stats.coverage.total} รายการ (${stats.coverage.percentExecuted}%)`,
  });
  body.push({ type: "table", headers: ["ระดับความเสี่ยง", "จำนวนช่องโหว่ที่ตรวจพบ"], rows: severityRows });
  const top = findings.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 5);
  if (top.length) {
    body.push({ type: "h3", text: "ช่องโหว่ระดับความเสี่ยงวิกฤตและสูงที่ควรดำเนินการโดยเร็ว" });
    body.push({ type: "bullets", items: top.map((f) => `F-${String(f.index).padStart(3, "0")} — ${f.title}`) });
  }

  body.push({ type: "h1", text: "6. บทวิเคราะห์การทดสอบเจาะระบบเว็บแอปพลิเคชัน" });
  body.push({
    type: "p",
    text: "ในบทนี้แสดงรายละเอียดของช่องโหว่ที่ตรวจพบแต่ละรายการ ประกอบด้วย หัวข้อ ระดับความเสี่ยง คะแนนและเวกเตอร์ CVSS v3.0 สิ่งที่ตรวจพบ หลักฐานการทดสอบ รายละเอียดผลกระทบ และแนวทางแก้ไข โดยเรียงลำดับจากความเสี่ยงสูงไปต่ำ",
  });
  if (!findings.length) {
    body.push({ type: "p", text: "ไม่พบช่องโหว่ที่ต้องรายงานจากการทดสอบในขอบเขตที่กำหนด" });
  }
  findings.forEach((finding, index) => {
    body.push({ type: "finding", finding: buildFindingCard(index, finding, byId.get(finding.id), options) });
  });

  const frontMatter: ClientReportFrontMatter = {
    cover: {
      titleLines: [
        "รายงานผลการทดสอบเจาะระบบเว็บแอปพลิเคชัน",
        "แบบทราบข้อมูลบางส่วน (Grey-Box Penetration Testing)",
        `ของ ${client}`,
      ],
      preparedBy: tester || "ทีมผู้ทดสอบ",
      client,
    },
    documentDetails: [
      ["ผู้ว่าจ้าง:", client],
      ["ประเภทของเอกสาร:", "รายงานผลการทดสอบเจาะระบบเว็บแอปพลิเคชันแบบทราบข้อมูลบางส่วน (Grey-Box Web Application Penetration Testing)"],
      ["โครงการ:", `โครงการทดสอบเจาะระบบสารสนเทศ (Penetration Testing) — ${options.session.name}`],
      ["ผู้จัดทำ:", tester || "—"],
      ["ผู้ตรวจสอบ:", "—"],
    ],
    abbreviations: [
      [client, "ผู้ว่าจ้าง"],
      ["ทีมผู้ทดสอบ", "ที่ปรึกษาฯ"],
      ["OWASP WSTG v4.2", "OWASP Web Security Testing Guide เวอร์ชัน 4.2"],
      ["OWASP Top 10:2025", "รายการช่องโหว่เว็บแอปพลิเคชันที่ร้ายแรงที่สุด 10 อันดับ ปี 2025"],
      ["CVSS v3.0", "Common Vulnerability Scoring System เวอร์ชัน 3.0 — มาตรฐานการให้คะแนนความเสี่ยงช่องโหว่ของ FIRST"],
      ["CWE", "Common Weakness Enumeration — รหัสจำแนกประเภทจุดอ่อนของระบบ"],
      ["โครงการฯ", "โครงการทดสอบเจาะระบบสารสนเทศของผู้ว่าจ้าง"],
    ],
    history: [["1.", thaiDate(generatedAt), "รายงานผลการทดสอบเจาะระบบเว็บแอปพลิเคชันของ " + client, options.version ?? "0.0.1", "ฉบับร่าง"]],
    testers: [{ name: tester || "—", position: "—", role: "Penetration Tester", email: "—", phone: "—" }],
    terms: `เอกสารฉบับนี้จัดทำขึ้นเพื่อ ${client} เท่านั้น การใช้งานข้อมูลส่วนหนึ่งส่วนใดให้เป็นไปตามขอบข่ายของสัญญาจ้างและสัญญาการไม่เปิดเผยความลับ ห้ามทำการเปลี่ยนแปลงส่วนหนึ่งส่วนใดของเอกสารฉบับนี้เว้นแต่จะได้รับอนุญาตเป็นลายลักษณ์อักษร การนำข้อมูลใด ๆ ที่ปรากฏในเอกสารนี้ไปเปิดเผย เผยแพร่ หรือส่งมอบให้กับบุคคลอื่นที่ไม่เกี่ยวข้อง อาจเป็นการละเมิดลิขสิทธิ์และทรัพย์สินทางปัญญาได้`,
    footerLine: `เอกสารฉบับนี้จัดทำขึ้นเพื่อ ${client} เท่านั้น — สงวนลิขสิทธิ์ ห้ามเผยแพร่โดยไม่ได้รับอนุญาต`,
  };

  const toc = [
    "รายละเอียดเอกสาร",
    "รายละเอียดคำย่อในเอกสาร",
    "ประวัติเอกสาร",
    "รายชื่อผู้ตรวจสอบระบบ",
    "เงื่อนไขการใช้งานและลิขสิทธิ์ทางปัญญา",
    "1. หลักการและเหตุผล",
    "2. วัตถุประสงค์",
    "3. เป้าหมายของโครงการ",
    "4. บทนำ",
    "5. บทสรุปสำหรับผู้บริหาร",
    "6. บทวิเคราะห์การทดสอบเจาะระบบเว็บแอปพลิเคชัน",
    ...findings.map((f, i) => `   6.${i + 1} F-${String(i + 1).padStart(3, "0")} — ${f.title}`),
  ];

  return {
    fileName: reportFileName({ ...options, generatedAt }).replace(/\.md$/, ".docx"),
    frontMatter,
    toc,
    body,
  };
}
