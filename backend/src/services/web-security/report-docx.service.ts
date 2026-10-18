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
  Footer,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import SessionsModel from "../../models/Sessions/Sessions.model";
import { getDataDir } from "../../utils/loadConfig";
import type { WebAppTestPlanDoc, SessionVulnerabilityDoc } from "../../models/Sessions/Sessions.model";
import {
  buildClientReport,
  reportSummaryInput,
  type ClientFinding,
  type ClientReport,
} from "./client-report.service";
import type { ReportOptions } from "./report.service";
import { generateReportSummary, type ReportSummaryDeps } from "./report-summary.service";
import { extractDocxText } from "./docx-text.service";

const THAI_FONT = "TH Sarabun New";
const MONO_FONT = "Consolas";

/** The report's palette: one deep navy for structure, one light blue for rules. */
const BRAND = "1F4E79";
const BRAND_MID = "2E74B5";
const BRAND_TEXT = "1F3864";
const RULE = "B4C6E7";
const LABEL_FILL = "EAF1FA";
const ZEBRA = "F5F8FC";
const GRID = "D6DCE4";
const EVIDENCE_FILL = "F5F5F5";

const BAND_FILL = { red: "C00000", orange: "ED7D31", yellow: "FFC000", grey: "A6A6A6" };
const BAND_TEXT = { red: "FFFFFF", orange: "FFFFFF", yellow: "000000", grey: "FFFFFF" };

const body = (text: string, extra: Record<string, unknown> = {}) =>
  new Paragraph({
    children: [new TextRun({ text, font: THAI_FONT, size: 32 })],
    spacing: { after: 120, line: 320 },
    ...extra,
  });

/**
 * A heading. Levels are the report's own styles (see reportStyles) rather than
 * Word's built-ins: the document is Thai, so every heading must name the Thai
 * font explicitly instead of falling back to the theme's Calibri.
 */
const heading = (text: string, style: "ReportH1" | "ReportH2" | "ReportH3") =>
  new Paragraph({ text, style, keepNext: true });

const bullets = (items: string[]) =>
  items.map(
    (text) =>
      new Paragraph({
        children: [new TextRun({ text, font: THAI_FONT, size: 32 })],
        bullet: { level: 0 },
        spacing: { after: 80, line: 300 },
      }),
  );

/**
 * Word counts a numbered list by the concrete numbering instance it references,
 * so two lists that share a reference keep counting as one. Each list here takes
 * its own instance, which restarts it at 1 — the counter is reset per document
 * in buildReportDocx.
 */
let numberListInstance = 0;

const numbers = (items: string[]) => {
  const instance = numberListInstance++;
  return items.map(
    (text) =>
      new Paragraph({
        children: [new TextRun({ text, font: THAI_FONT, size: 32 })],
        numbering: { reference: "report-numbers", level: 0, instance },
        spacing: { after: 80, line: 300 },
      }),
  );
};

/** A table cell: bold-on-a-fill for headers/labels, plain otherwise. */
const cell = (
  text: unknown,
  { fill, color = "000000", bold = false, width }: { fill?: string; color?: string; bold?: boolean; width?: number } = {},
) =>
  new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [new TextRun({ text: String(text ?? "—"), font: THAI_FONT, size: 30, bold, color })],
        spacing: { after: 0, line: 280 },
      }),
    ],
  });

/** The cell borders of a grid table — a light rule instead of Word's black. */
const GRID_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: GRID },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: GRID },
  left: { style: BorderStyle.SINGLE, size: 4, color: GRID },
  right: { style: BorderStyle.SINGLE, size: 4, color: GRID },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: GRID },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: GRID },
};

/** A grid table: navy header row, zebra body, light rules. */
const tableFrom = (headers: string[], rows: string[][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: GRID_BORDERS,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h) => cell(h, { fill: BRAND, color: "FFFFFF", bold: true })),
      }),
      ...rows.map(
        (row, index) =>
          new TableRow({
            children: row.map((value) =>
              cell(value, index % 2 === 1 ? { fill: ZEBRA } : {}),
            ),
          }),
      ),
    ],
  });

/**
 * A label/value table with no outer grid: the label column is a soft blue
 * block and the values sit on the same line, so a finding's attributes read as
 * a form rather than a spreadsheet.
 */
const detailTable = (pairs: [string, string][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: "auto" },
      bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
      left: { style: BorderStyle.NONE, size: 0, color: "auto" },
      right: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
    rows: pairs.map(
      ([label, value]) =>
        new TableRow({
          children: [
            cell(label, { fill: LABEL_FILL, color: BRAND_TEXT, bold: true, width: 28 }),
            cell(value, { width: 72 }),
          ],
        }),
    ),
  });

/** A bold, brand-coloured label that opens a block inside a finding card. */
const fieldLabel = (text: string) =>
  new Paragraph({
    children: [new TextRun({ text, font: THAI_FONT, size: 32, bold: true, color: BRAND_TEXT })],
    spacing: { before: 160, after: 80 },
    keepNext: true,
  });

function findingCard(finding: ClientFinding) {
  const fill = BAND_FILL[finding.band] ?? BAND_FILL.grey;
  const color = BAND_TEXT[finding.band] ?? "FFFFFF";
  // The classification the reader came for: the OWASP category, the WSTG case
  // and the CWE weakness are stated as their own rows. CVE is printed only
  // when one was actually identified — an empty row would read as "none exists".
  const details: [string, string][] = [
    ["OWASP Top 10:2025 :", finding.owasp],
    ["อ้างอิงเคสทดสอบ (WSTG) :", finding.goal],
    ["CWE :", finding.cwe ?? "ไม่ได้บันทึก"],
  ];
  if (finding.cve) details.push(["CVE :", finding.cve]);
  details.push(["วันที่ค้นพบช่องโหว่ :", finding.discoveredOn]);

  const children: (Paragraph | Table)[] = [
    // The card is headed by the finding's own title: the F-00N code is an
    // internal index, and the client document prints no code the reader would
    // have to look up. The code still exists on the block (and orders the
    // cards) — it just never reaches the page.
    heading(finding.title, "ReportH2"),
    detailTable(details),
    body(""),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: GRID_BORDERS,
      rows: [
        new TableRow({
          tableHeader: true,
          children: ["ระดับความเสี่ยง", "คะแนนฐาน CVSS v3.0", "เวกเตอร์ CVSS v3.0"].map((h) =>
            cell(h, { fill: BRAND, color: "FFFFFF", bold: true }),
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
    fieldLabel("สิ่งที่ตรวจพบ"),
    ...bullets(finding.discovered ?? []),
  ];

  if (finding.steps?.length) {
    children.push(fieldLabel("ขั้นตอนการทดสอบ"));
    children.push(...numbers(finding.steps));
  }

  if (finding.evidence) {
    children.push(fieldLabel("หลักฐานการทดสอบ"));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: finding.evidence, font: MONO_FONT, size: 20, color: "333333" })],
        shading: { type: ShadingType.CLEAR, fill: EVIDENCE_FILL },
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, color: GRID },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: GRID },
          left: { style: BorderStyle.SINGLE, size: 12, color: BRAND_MID },
          right: { style: BorderStyle.SINGLE, size: 4, color: GRID },
        },
        spacing: { after: 120, line: 260 },
        indent: { left: 120 },
      }),
    );
  }

  children.push(fieldLabel("รายละเอียดผลกระทบ"));
  children.push(...bullets(finding.impactDetails ?? []));
  children.push(fieldLabel("แนวทางแก้ไข และคำแนะนำ"));
  children.push(...bullets(finding.recommendations ?? []));
  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

function blockToDocx(block: ClientReport["body"][number]) {
  switch (block.type) {
    case "h1":
      return [heading(block.text, "ReportH1")];
    case "h2":
      return [heading(block.text, "ReportH2")];
    case "h3":
      return [heading(block.text, "ReportH3")];
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
 * The document is its own table of contents: a title block, the summary the
 * reader meets first, the risk counts, then one section per finding. There is
 * no cover, front matter, table of contents or terms chapter to render, so
 * nothing here can drift from the findings. The one piece of furniture is the
 * footer — the document title and a page number — which is a fixed string plus
 * a field, not report content.
 */
export async function buildReportDocx(report: ClientReport): Promise<Buffer> {
  numberListInstance = 0;
  const titleBlock = [
    new Paragraph({
      children: [new TextRun({ text: report.title, font: THAI_FONT, size: 48, bold: true, color: BRAND })],
      spacing: { after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BRAND_MID, space: 6 } },
    }),
    new Paragraph({
      children: [new TextRun({ text: report.subtitle, font: THAI_FONT, size: 28, color: "595959" })],
      spacing: { before: 80, after: 280 },
    }),
  ];

  const children = [...titleBlock, ...report.body.flatMap((block) => blockToDocx(block))];

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: `${report.title}  |  หน้า `, font: THAI_FONT, size: 18, color: "808080" }),
          new TextRun({ children: [PageNumber.CURRENT], font: THAI_FONT, size: 18, color: "808080" }),
          new TextRun({ text: " / ", font: THAI_FONT, size: 18, color: "808080" }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: THAI_FONT, size: 18, color: "808080" }),
        ],
      }),
    ],
  });

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "report-numbers",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    styles: {
      default: { document: { run: { font: THAI_FONT, size: 32 } } },
      paragraphStyles: [
        {
          id: "ReportH1",
          name: "Report H1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: THAI_FONT, size: 36, bold: true, color: "FFFFFF" },
          paragraph: {
            shading: { type: ShadingType.CLEAR, fill: BRAND },
            spacing: { before: 320, after: 200, line: 300 },
            indent: { left: 140, right: 140 },
            border: {
              top: { style: BorderStyle.SINGLE, size: 4, color: BRAND },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: BRAND },
              left: { style: BorderStyle.SINGLE, size: 4, color: BRAND },
              right: { style: BorderStyle.SINGLE, size: 4, color: BRAND },
            },
          },
        },
        {
          id: "ReportH2",
          name: "Report H2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: THAI_FONT, size: 32, bold: true, color: BRAND_TEXT },
          paragraph: {
            spacing: { before: 260, after: 140, line: 300 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: RULE, space: 4 } },
          },
        },
        {
          id: "ReportH3",
          name: "Report H3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: THAI_FONT, size: 30, bold: true, color: BRAND_MID },
          paragraph: { spacing: { before: 200, after: 120, line: 300 } },
        },
      ],
    },
    sections: [
      {
        properties: {},
        footers: { default: footer },
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
const REPORT_FORMAT_VERSION = 3;

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
    // Everything the document actually renders. Hashing only id/title/severity/
    // CVSS meant an edit to the evidence, impact, remediation or CWE left the
    // signature unchanged, so ensureReportDocx served the stale file and the
    // report no longer matched the tracked findings.
    v.description,
    v.contextSummary,
    v.evidence,
    v.impact,
    v.stepsToReproduce,
    v.remediation,
    v.cwe,
    v.cve,
    v.wstgId,
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
