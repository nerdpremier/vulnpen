/**
 * Server-side .docx builder for the Thai client report — the same document the
 * frontend preview shows. The generated file is the unit of work for
 * LibreOffice: it is stored per session, opened for editing through WOPI
 * (Collabora) and converted to PDF with soffice.
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
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import SessionsModel from "../../models/Sessions/Sessions.model";
import { getDataDir } from "../../utils/loadConfig";
import type { WebAppTestPlanDoc, SessionVulnerabilityDoc } from "../../models/Sessions/Sessions.model";
import { buildClientReport, type ClientFinding, type ClientReport } from "./client-report.service";

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
        numbering: { reference: "client-goals", level: 0 },
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

function findingCard(finding: ClientFinding, index: number) {
  const fill = BAND_FILL[finding.band] ?? BAND_FILL.grey;
  const color = BAND_TEXT[finding.band] ?? "FFFFFF";
  const children: (Paragraph | Table)[] = [
    heading(`6.${index + 1} ${finding.code} — ${finding.title}`, HeadingLevel.HEADING_2),
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

function blockToDocx(block: ClientReport["body"][number], findingCounter: { count: number }) {
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
      return findingCard(block.finding, findingCounter.count++);
    default:
      return [];
  }
}

export async function buildClientDocx(client: ClientReport): Promise<Buffer> {
  const { frontMatter, body: blocks } = client;
  const findingCounter = { count: 0 };

  const cover = [
    ...Array.from({ length: 6 }, () => new Paragraph({ children: [] })),
    ...frontMatter.cover.titleLines.map((line, index) =>
      new Paragraph({
        children: [new TextRun({ text: line, font: THAI_FONT, size: index === 0 ? 56 : 44, bold: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
    ),
    ...Array.from({ length: 3 }, () => new Paragraph({ children: [] })),
    body(`จัดทำโดย ${frontMatter.cover.preparedBy}`, { alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const frontMatterChildren = [
    heading("รายละเอียดเอกสาร", HeadingLevel.HEADING_1),
    detailTable(frontMatter.documentDetails),
    new Paragraph({ children: [new PageBreak()] }),
    heading("รายละเอียดคำย่อในเอกสาร", HeadingLevel.HEADING_1),
    body(
      "เพื่อให้ผู้ที่เกี่ยวข้องกับโครงการสามารถศึกษาผลของการทดสอบเจาะระบบจากรายงานฉบับนี้ได้ง่ายขึ้น และเพื่อความเข้าใจที่ตรงกัน ขออนุญาตใช้ชื่อย่อดังนี้",
    ),
    detailTable(frontMatter.abbreviations),
    new Paragraph({ children: [new PageBreak()] }),
    heading("ประวัติเอกสาร", HeadingLevel.HEADING_1),
    tableFrom(["ที่", "วันที่", "ชื่อเอกสาร", "เวอร์ชัน", "รายละเอียด"], frontMatter.history),
    new Paragraph({ children: [new PageBreak()] }),
    heading("รายชื่อผู้ตรวจสอบระบบ", HeadingLevel.HEADING_1),
    ...frontMatter.testers.flatMap((tester) => [detailTable(Object.entries(tester)), body("")]),
    new Paragraph({ children: [new PageBreak()] }),
    heading("เงื่อนไขการใช้งานและลิขสิทธิ์ทางปัญญา", HeadingLevel.HEADING_1),
    body(frontMatter.terms),
    new Paragraph({ children: [new PageBreak()] }),
    heading("สารบัญ", HeadingLevel.HEADING_1),
    new TableOfContents("สารบัญ", { hyperlink: true, headingStyleRange: "1-2" }),
    body(
      "หมายเหตุ: เมื่อเปิดไฟล์ใน Microsoft Word ให้คลิกขวาที่สารบัญแล้วเลือก Update Field เพื่ออัปเดตเลขหน้า",
    ),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const bodyChildren = blocks.flatMap((block) => blockToDocx(block, findingCounter));

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "client-goals",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    styles: { default: { document: { run: { font: THAI_FONT, size: 32 } } } },
    features: { updateFields: true },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `หน้า ${PageNumber.CURRENT} จาก ${PageNumber.TOTAL_PAGES}  `,
                    font: THAI_FONT,
                    size: 24,
                    color: "595959",
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: frontMatter.footerLine, font: THAI_FONT, size: 22, color: "595959" }),
                ],
              }),
            ],
          }),
        },
        children: [...cover, ...frontMatterChildren, ...bodyChildren],
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

function readReportMeta(sessionId: string): { signature?: string; editedByWord?: boolean; fileName?: string } {
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
    v.status,
    v.severity,
    v.cvss?.score,
    v.cvss?.vector,
    v.createdAt,
  ]);
  const cases = (session.webAppTestPlan?.cases ?? []).map((c) => [c.testId, c.status]);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ name: session.name, description: session.description, createdAt: session.createdAt, vulns, cases }))
    .digest("hex");
}

/**
 * The stored .docx is the working document for LibreOffice. It is (re)built
 * from session data while the tester has not hand-edited it in Word; once a
 * Word save arrives the file is authoritative and never regenerated — unless
 * the caller explicitly asks to rebuild, which is the operator's decision to
 * discard their own edits in favour of the engagement's current results.
 */
export async function ensureReportDocx(
  sessionId: string,
  uid: unknown,
  options: { force?: boolean } = {},
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

  const client = buildClientReport({
    session: {
      sessionId,
      name: refreshed.name ?? "Engagement",
      description: refreshed.description ?? "",
      createdAt: refreshed.createdAt as unknown as Date,
    },
    vulnerabilities: (refreshed.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
    testPlan: (refreshed.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null,
  });

  const buffer = await buildClientDocx(client);
  fs.writeFileSync(filePath, buffer);
  fs.writeFileSync(reportMetaPath(sessionId), JSON.stringify({ signature, editedByWord: false, fileName: client.fileName }));
  return { filePath, fileName: client.fileName };
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

/** Convert the stored .docx to PDF with headless LibreOffice. */
export async function convertReportToPdf(docxPath: string): Promise<Buffer> {
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
