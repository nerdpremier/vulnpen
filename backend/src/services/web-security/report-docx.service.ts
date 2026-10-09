/**
 * The server-side .docx builder for the report — the same document the
 * frontend preview shows: the model's summary, the risk table, one card per
 * finding. The generated file is the unit of work for LibreOffice: it is stored
 * per session, opened for editing through WOPI (Collabora) and converted to PDF.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import SessionsModel from "../../models/Sessions/Sessions.model";
import { getDataDir } from "../../utils/loadConfig";
import type { WebAppTestPlanDoc, SessionVulnerabilityDoc } from "../../models/Sessions/Sessions.model";
import {
  buildDraftReport,
  buildClientReport,
  reportSummaryInput,
  type ClientFinding,
  type ClientReport,
} from "./client-report.service";
import type { ReportOptions } from "./report.service";
import { generateReportSummary, type ReportSummaryDeps } from "./report-summary.service";
import { extractDocxText } from "./docx-text.service";

const THAI_FONT = "TH Sarabun New";
const HEADER_BLUE = "4472C4";
const LABEL_BLUE = "5B9BD5";
const BAND_FILL = { red: "C00000", orange: "ED7D31", yellow: "FFC000", grey: "A6A6A6" };
const BAND_TEXT = { red: "FFFFFF", orange: "FFFFFF", yellow: "000000", grey: "FFFFFF" };

const body = (text: string, extra: Record<string, unknown> = {}) =>
  new Paragraph({
    children: [new TextRun({ text, font: THAI_FONT, size: 32 })],
    spacing: { after: 120, line: 320 },
    ...extra,
  });

const heading = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) =>
  new Paragraph({
    text,
    heading: level,
    spacing: { before: 240, after: 160 },
  });

const bullets = (items: string[]) =>
  items.map(
    (text) =>
      new Paragraph({
        children: [new TextRun({ text, font: THAI_FONT, size: 32 })],
        bullet: { level: 0 },
        spacing: { after: 80, line: 300 },
      }),
  );

const numbers = (items: string[]) =>
  items.map(
    (text) =>
      new Paragraph({
        children: [new TextRun({ text, font: THAI_FONT, size: 32 })],
        numbering: { reference: "report-numbers", level: 0 },
        spacing: { after: 80, line: 300 },
      }),
  );

const cell = (
  text: unknown,
  { fill, color = "000000", bold = false, width }: { fill?: string; color?: string; bold?: boolean; width?: number } = {},
) =>
  new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    children: [
      new Paragraph({
        children: [new TextRun({ text: String(text ?? "—"), font: THAI_FONT, size: 30, bold, color })],
        spacing: { after: 40 },
      }),
    ],
  });

const tableFrom = (headers: string[], rows: string[][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h) => cell(h, { fill: HEADER_BLUE, color: "FFFFFF", bold: true })),
      }),
      ...rows.map((row) => new TableRow({ children: row.map((value) => cell(value)) })),
    ],
  });

const detailTable = (pairs: [string, string][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: pairs.map(
      ([label, value]) =>
        new TableRow({
          children: [cell(label, { fill: LABEL_BLUE, color: "FFFFFF", bold: true, width: 28 }), cell(value, { width: 72 })],
        }),
    ),
  });

function findingCard(finding: ClientFinding) {
  const fill = BAND_FILL[finding.band] ?? BAND_FILL.grey;
  const color = BAND_TEXT[finding.band] ?? "FFFFFF";
  const children: (Paragraph | Table)[] = [
    heading(`${finding.code} — ${finding.title}`, HeadingLevel.HEADING_2),
    detailTable([
      ["หัวข้อ :", `${finding.code} — ${finding.title}`],
      ["OWASP Top 10:2025 :", finding.owasp],
      ["เป้าหมายการทดสอบ :", finding.goal],
      ["รูปแบบการทดสอบ :", finding.method],
      ["วันที่ค้นพบช่องโหว่ :", finding.discoveredOn],
    ]),
    body(""),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          tableHeader: true,
          children: ["ระดับความเสี่ยง", "คะแนนฐาน CVSS v3.0", "เวกเตอร์ CVSS v3.0"].map((h) =>
            cell(h, { fill: "70AD47", color: "FFFFFF", bold: true }),
          ),
        }),
        new TableRow({
          children: [
            finding.risk,
            finding.cvssScore ?? "ไม่ได้ประเมิน",
            finding.cvssVector ?? "—",
          ].map((value) => cell(value, { fill, color, bold: true })),
        }),
      ],
    }),
    body(""),
    body("สิ่งที่ตรวจพบ :", { spacing: { before: 120, after: 80 }, alignment: AlignmentType.LEFT }),
    ...bullets(finding.discovered ?? []),
  ];

  if (finding.steps?.length) {
    children.push(body("ขั้นตอนการทดสอบ :", { spacing: { before: 120, after: 80 } }));
    children.push(...numbers(finding.steps));
  }

  if (finding.evidence) {
    children.push(body("หลักฐานการทดสอบ :", { spacing: { before: 120, after: 80 } }));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: finding.evidence, font: "Consolas", size: 20, color: "333333" })],
        shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
          left: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
          right: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
        },
        spacing: { after: 120 },
      }),
    );
  }

  children.push(body("รายละเอียดผลกระทบ :", { spacing: { before: 120, after: 80 } }));
  children.push(...bullets(finding.impactDetails ?? []));
  children.push(body("แนวทางแก้ไข และคำแนะนำ :", { spacing: { before: 120, after: 80 } }));
  children.push(...bullets(finding.recommendations ?? []));
  if (finding.references?.length) {
    children.push(body("ศึกษาเพิ่มเติม :", { spacing: { before: 120, after: 80 } }));
    children.push(...bullets(finding.references));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

function blockToDocx(block: ClientReport["body"][number]) {
  switch (block.type) {
    case "h1":
      return [heading(block.text, HeadingLevel.HEADING_1)];
    case "h2":
      return [heading(block.text, HeadingLevel.HEADING_2)];
    case "h3":
      return [heading(block.text, HeadingLevel.HEADING_3)];
    case "p":
      return [body(block.text)];
    case "bullets":
      return bullets(block.items);
    case "numbers":
      return numbers(block.items);
    case "table":
      return [tableFrom(block.headers, block.rows), body("")];
    case "finding":
      return findingCard(block.finding);
    default:
      return [];
  }
}

/**
 * Render the report.
 *
 * The document is its own table of contents: a heading, the summary the reader
 * meets first, the risk counts, then one section per finding. There is no cover,
 * front matter, table of contents, terms chapter or page-number footer to
 * render, so there is nothing here that could drift from the findings.
 */
export async function buildReportDocx(report: ClientReport): Promise<Buffer> {
  const children = [
    new Paragraph({
      children: [new TextRun({ text: report.title, font: THAI_FONT, size: 40, bold: true })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: report.subtitle, font: THAI_FONT, size: 26, color: "595959" })],
      spacing: { after: 240 },
    }),
    ...report.body.flatMap((block) => blockToDocx(block)),
  ];

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "report-numbers",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    styles: { default: { document: { run: { font: THAI_FONT, size: 32 } } } },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function reportsDir(): string {
  const dir = path.join(getDataDir(), "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function reportDocxPath(sessionId: string): string {
  return path.join(reportsDir(), `${sessionId}.docx`);
}

function reportMetaPath(sessionId: string): string {
  return path.join(reportsDir(), `${sessionId}.meta.json`);
}

interface ReportMeta {
  signature?: string;
  editedByWord?: boolean;
  fileName?: string;
  /** The summary the stored document opens with, so the preview matches it. */
  summary?: string;
}

function readReportMeta(sessionId: string): ReportMeta {
  try {
    return JSON.parse(fs.readFileSync(reportMetaPath(sessionId), "utf-8"));
  } catch {
    return {};
  }
}

/** Word-side saves (WOPI PutFile) mark the document as hand-edited so the
 *  generator never overwrites the tester's changes. */
export function markReportEditedByWord(sessionId: string): void {
  const meta = readReportMeta(sessionId);
  meta.editedByWord = true;
  fs.writeFileSync(reportMetaPath(sessionId), JSON.stringify(meta));
}

/**
 * Whether the working document carries hand edits. The UI has to say so: once
 * Word has saved it, later scans and findings are deliberately *not* merged,
 * and an operator who does not know that ships a stale report.
 */
export function reportDocxStatus(sessionId: string): { editedByWord: boolean } {
  return { editedByWord: readReportMeta(sessionId).editedByWord === true };
}

/**
 * The summary the stored document was built with. The JSON preview renders the
 * document, so it has to show the same opening the .docx does rather than a
 * second, differently-worded one.
 */
export function readReportSummary(sessionId: string): string | undefined {
  return readReportMeta(sessionId).summary;
}

export interface ReportDocumentReading {
  fileName: string;
  /** True once Word saved it: the file is authoritative and never regenerated. */
  editedByWord: boolean;
  /** When the document on disk was last written — by the generator or by Word. */
  savedAt: Date;
  bytes: number;
  text: string;
}

/**
 * The stored document as text.
 *
 * The report is edited in Word, so the document is the record of what it says:
 * the generator cannot state what the tester rewrote, and the findings it was
 * built from do not move when the prose does. Undefined when this session has
 * no document yet.
 */
export function readReportDocument(sessionId: string): ReportDocumentReading | undefined {
  const filePath = reportDocxPath(sessionId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  const meta = readReportMeta(sessionId);
  return {
    fileName: meta.fileName ?? `${sessionId}.docx`,
    editedByWord: meta.editedByWord === true,
    savedAt: stat.mtime,
    bytes: stat.size,
    text: extractDocxText(fs.readFileSync(filePath)),
  };
}

/**
 * Bumped whenever the document's shape changes, because the fingerprint below
 * decides whether a stored .docx is still current: without this, a session
 * whose document was built by an older format keeps being served that older
 * document forever, and only `rebuild=1` would ever refresh it.
 */
const REPORT_FORMAT_VERSION = 2;

/** Fingerprint of the session data the deterministic report is built from. */
function reportSignature(session: {
  name?: string;
  description?: string;
  createdAt?: Date;
  vulnerabilities?: SessionVulnerabilityDoc[];
  webAppTestPlan?: WebAppTestPlanDoc | null;
}): string {
  const vulns = (session.vulnerabilities ?? []).map((v) => [
    v.vulnerabilityId,
    v.title,
    v.severity,
    v.cvss?.score,
    v.cvss?.vector,
    v.createdAt,
  ]);
  const cases = (session.webAppTestPlan?.cases ?? []).map((c) => [c.testId, c.status]);
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        format: REPORT_FORMAT_VERSION,
        name: session.name,
        description: session.description,
        createdAt: session.createdAt,
        vulns,
        cases,
      }),
    )
    .digest("hex");
}

/**
 * The stored .docx is the working document for LibreOffice. It is (re)built
 * from session data while the tester has not hand-edited it in Word; once a
 * Word save arrives the file is authoritative and never regenerated — unless
 * the caller explicitly asks to rebuild, which is the operator's decision to
 * discard their own edits in favour of the engagement's current results.
 *
 * A rebuild is also when the model writes the document's opening summary, so a
 * summary costs one call per version of the findings rather than one per open.
 * The call is best-effort: when it fails the document is built with its own
 * summary line and the report still opens.
 */
export async function ensureReportDocx(
  sessionId: string,
  uid: unknown,
  options: { force?: boolean; deps?: ReportSummaryDeps } = {},
): Promise<{ filePath: string; fileName: string }> {
  const refreshed = await SessionsModel.findOne({ sessionId, uid })
    .select("name description createdAt vulnerabilities webAppTestPlan")
    .lean();
  if (!refreshed) throw new Error("Session not found");

  const filePath = reportDocxPath(sessionId);
  const meta = readReportMeta(sessionId);
  const signature = reportSignature(refreshed as never);
  const stale =
    options.force === true ||
    !fs.existsSync(filePath) ||
    (!meta.editedByWord && meta.signature !== signature);
  if (!stale) {
    return { filePath, fileName: meta.fileName ?? `${sessionId}.docx` };
  }

  const reportOptions: ReportOptions = {
    session: {
      sessionId,
      name: refreshed.name ?? "Engagement",
      description: refreshed.description ?? "",
      createdAt: refreshed.createdAt as unknown as Date,
    },
    vulnerabilities: (refreshed.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
    testPlan: (refreshed.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null,
  };

  const summary = await generateReportSummary(reportSummaryInput(reportOptions), {
    userId: typeof uid === "string" ? uid : String(uid),
    sessionId,
    deps: options.deps,
  });
  const report = buildClientReport({ ...reportOptions, summary });

  const buffer = await buildReportDocx(report);
  fs.writeFileSync(filePath, buffer);
  fs.writeFileSync(
    reportMetaPath(sessionId),
    JSON.stringify({ signature, editedByWord: false, fileName: report.fileName, summary }),
  );
  return { filePath, fileName: report.fileName };
}

/**
 * Build the draft .docx on demand: the same document, without the model's
 * summary. It is never stored as the working document (Collabora edits that
 * one), so every call rebuilds it from the engagement's current findings — a
 * draft that lagged behind the results would be worse than no draft.
 */
export async function buildDraftReportDocx(
  sessionId: string,
  uid: unknown,
): Promise<{ buffer: Buffer; fileName: string }> {
  const refreshed = await SessionsModel.findOne({ sessionId, uid })
    .select("name description createdAt vulnerabilities webAppTestPlan")
    .lean();
  if (!refreshed) throw new Error("Session not found");

  const client = buildDraftReport({
    session: {
      sessionId,
      name: refreshed.name ?? "Engagement",
      description: refreshed.description ?? "",
      createdAt: refreshed.createdAt as unknown as Date,
    },
    vulnerabilities: (refreshed.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
    testPlan: (refreshed.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null,
  });

  const buffer = await buildReportDocx(client);
  return { buffer, fileName: client.fileName };
}

export function findSoffice(): string | null {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    process.platform === "win32" ? "C:\\Program Files\\LibreOffice\\program\\soffice.exe" : null,
    process.platform === "win32" ? "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe" : null,
    "/usr/bin/soffice",
    "/opt/libreoffice/program/soffice",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return process.platform === "win32" ? null : "soffice";
}

/**
 * Convert the stored .docx to PDF. Prefers Collabora's /cool/convert-to
 * endpoint (always present wherever the report editor runs); falls back to a
 * local headless LibreOffice for host-run backends without Collabora.
 */
export async function convertReportToPdf(docxPath: string): Promise<Buffer> {
  const collabora = (process.env.COLLABORA_URL || "").replace(/\/$/, "");
  if (collabora) {
    try {
      return await convertViaCollabora(collabora, docxPath);
    } catch (err) {
      console.warn(
        `[report] Collabora PDF conversion failed (${(err as Error)?.message}), falling back to soffice`,
      );
    }
  }
  return convertViaSoffice(docxPath);
}

/** POST the .docx to Collabora's convert-to endpoint and return the PDF. */
async function convertViaCollabora(collaboraBase: string, docxPath: string): Promise<Buffer> {
  const buffer = fs.readFileSync(docxPath);
  const form = new FormData();
  form.append(
    "data",
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    path.basename(docxPath),
  );
  form.append("format", "pdf");
  const res = await fetch(`${collaboraBase}/cool/convert-to`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Collabora convert-to failed with HTTP ${res.status}`);
  }
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.slice(0, 5).toString() !== "%PDF-") {
    throw new Error("Collabora convert-to did not return a PDF document");
  }
  return pdf;
}

/** Convert with a locally installed headless LibreOffice (host dev mode). */
async function convertViaSoffice(docxPath: string): Promise<Buffer> {
  const soffice = findSoffice();
  if (!soffice) throw new Error("LibreOffice (soffice) is not installed on the server");

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnpen-pdf-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnpen-lo-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        soffice,
        [
          `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
          "--headless",
          "--norestore",
          "--convert-to",
          "pdf",
          "--outdir",
          outDir,
          docxPath,
        ],
        { windowsHide: true },
      );
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("LibreOffice conversion timed out"));
      }, 120_000);
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exited with code ${code}`));
      });
    });

    const pdfPath = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, ".pdf"));
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}
