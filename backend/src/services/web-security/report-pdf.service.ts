/**
 * The report as a print-ready PDF.
 *
 * The .docx (report-docx.service.ts) is the working copy the tester opens in
 * Collabora and rewrites; this module produces the deliverable. Word cannot
 * express the design — a full-bleed cover, a table of contents with real page
 * numbers, one card per finding — so the document is laid out as HTML
 * (report-html.service.ts) and printed by the Chromium the image already ships
 * for the browser agent.
 *
 * Two things the browser does not give us for free, and how they are handled:
 *
 *   Page numbers. Word computes a TOC field itself; HTML has to be told. The
 *   document is laid out at exactly the printed text width, each top-level
 *   block is measured, and the resulting pagination is written into the TOC
 *   before printing (see `measurePages`). Every TOC target starts a page, so
 *   the simulation only has to know how many pages each block spans.
 *
 *   The full-bleed cover. The page margins come from CSS `@page` (with
 *   `preferCSSPageSize`), which lets the cover opt out with its own named page
 *   — a single render, no PDF stitching, and the running footer still works.
 *
 * The result is cached beside the .docx and rebuilt when the findings, the
 * summary or the template change. When the document was hand-edited in Word the
 * HTML renderer is bypassed entirely: those edits are the report, and printing
 * the template over them would silently discard the tester's work.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import SessionsModel from "../../models/Sessions/Sessions.model";
import type {
  EngagementContextDoc,
  SessionVulnerabilityDoc,
  WebAppTestPlanDoc,
} from "../../models/Sessions/Sessions.model";
import { buildClientReport, type ClientReport } from "./client-report.service";
import {
  buildReportFindings,
  computeReportStats,
  type ReportOptions,
  type ReportStats,
} from "./report.service";
import { PAGE_BOX, buildReportHtml, type ReportHtmlContext } from "./report-html.service";
import {
  convertReportToPdf,
  ensureReportDocx,
  readReportSummary,
  reportDocxPath,
  reportDocxStatus,
} from "./report-docx.service";

/**
 * Bumped when the printed layout changes. The stored PDF is fingerprinted on
 * its own content, so without this a design change would never reach a session
 * that had already been exported once.
 */
const TEMPLATE_VERSION = 2;

const RENDER_TIMEOUT_MS = 120_000;

/**
 * The running footer, drawn by Chromium's own header/footer layer.
 *
 * Latin only, on purpose: that layer has no Thai font to fall back on, so Thai
 * text there prints as empty boxes. It carries the page number and nothing
 * else — the report does not stamp a classification on every page.
 */
const FOOTER = `<div style="width:100%;padding:0 14mm;font-family:Arial,Helvetica,sans-serif;
  font-size:7.5pt;color:#93a2b3;display:flex;justify-content:flex-end;align-items:center;
  border-top:.5px solid #e3e9f1;padding-top:2mm;">
  <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

export interface ReportPdfResult {
  filePath: string;
  fileName: string;
  /** Which pipeline produced the file: the designed render, or the .docx. */
  source: "html" | "docx";
}

function reportsDir(): string {
  return path.dirname(reportDocxPath("x"));
}

export function reportPdfPath(sessionId: string): string {
  return path.join(reportsDir(), `${sessionId}.pdf`);
}

function pdfMetaPath(sessionId: string): string {
  return path.join(reportsDir(), `${sessionId}.pdf.json`);
}

interface PdfMeta {
  signature?: string;
  fileName?: string;
}

function readPdfMeta(sessionId: string): PdfMeta {
  try {
    return JSON.parse(fs.readFileSync(pdfMetaPath(sessionId), "utf-8"));
  } catch {
    return {};
  }
}

const pdfFileName = (docxName: string): string =>
  docxName.replace(/\.docx$/i, ".pdf");

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One page per finding is the point of the layout, and a card that runs a few
 * lines over would otherwise spill a single paragraph onto a page of its own.
 * Chromium's `zoom` is a layout property — the card reflows narrower and comes
 * back shorter — so the cards are shrunk until the longest one fits.
 *
 * The scale is uniform, not per card: a document whose type changes size from
 * page to page reads as a defect. The longest card decides it for all of them,
 * and `floor` stops a pathological finding from shrinking the whole report into
 * illegibility (it spills onto a second page instead).
 */
function fitCards({ heightMm, floor }: { heightMm: number; floor: number }): number {
  const limit = (heightMm * 96) / 25.4 - 6;
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".finding"));
  const needed = cards.map((card) => {
    let zoom = 1;
    while (card.getBoundingClientRect().height > limit && zoom - 0.02 >= floor) {
      zoom = Math.round((zoom - 0.02) * 100) / 100;
      card.style.zoom = String(zoom);
    }
    return zoom;
  });
  const uniform = needed.length ? Math.min(1, ...needed) : 1;
  cards.forEach((card) => {
    card.style.zoom = String(uniform);
  });
  return uniform;
}

/**
 * Which page each TOC target lands on.
 *
 * Runs in the page, at the printed text width. Every TOC target starts a new
 * page (`break-before: page`), so the walk is exact for the blocks that matter:
 * a block that starts a page is at the current page, and it consumes as many
 * pages as its height needs. The cover is its own named page and always exactly
 * one page, whatever its declared height.
 */
function measurePages({ heightMm }: { heightMm: number }): Record<string, number> {
  const PX_TO_MM = 25.4 / 96;
  const result: Record<string, number> = {};
  let page = 1;
  let used = 0;

  for (const node of Array.from(document.body.children) as HTMLElement[]) {
    const style = getComputedStyle(node);
    const key = node.dataset.pageKey;
    const height = node.getBoundingClientRect().height * PX_TO_MM;

    if ((style as unknown as { page?: string }).page === "cover") {
      if (key) result[key] = page;
      page += 1;
      used = 0;
      continue;
    }

    if (style.breakBefore === "page" && used > 0) {
      page += 1;
      used = 0;
    }
    if (key) result[key] = page;

    const total = used + height;
    if (total > heightMm) {
      const extra = Math.ceil(total / heightMm) - 1;
      page += extra;
      used = total - extra * heightMm;
    } else {
      used = total;
    }
  }

  return result;
}

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const { chromium } = await import("patchright");
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    // Lay the document out at exactly the width the printer will use, so that
    // measuring a block's height means what it means on paper.
    await page.setViewportSize({
      width: Math.round((PAGE_BOX.widthMm * 96) / 25.4),
      height: Math.round((PAGE_BOX.heightMm * 96) / 25.4),
    });
    await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    // The faces are data URIs, so they are resolved by `load`; waiting on the
    // font set as well keeps a slow decode from printing fallback glyphs.
    await page.evaluate(() => document.fonts.ready.then(() => true));

    // Shrink the cards that run over a page first: the page numbers are read
    // from the pagination the document ends up with, not the one it starts at.
    const zoom = await page.evaluate(fitCards, { heightMm: PAGE_BOX.heightMm, floor: 0.78 });
    if (zoom < 1) {
      console.log(`[report] finding cards scaled to ${zoom} so each one fits its page`);
    }
    const pageMap = await page.evaluate(measurePages, { heightMm: PAGE_BOX.heightMm });
    await page.evaluate((map) => {
      document.querySelectorAll<HTMLElement>("[data-toc-key]").forEach((cell) => {
        const target = map[cell.dataset.tocKey ?? ""];
        if (target) cell.textContent = String(target);
      });
    }, pageMap);

    const pdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: FOOTER,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

type SessionRecord = {
  name?: string;
  description?: string;
  createdAt?: Date;
  vulnerabilities?: SessionVulnerabilityDoc[];
  webAppTestPlan?: WebAppTestPlanDoc | null;
  engagementContext?: EngagementContextDoc;
};

/**
 * What the document prints around the findings. The target and scope come from
 * the engagement itself — the session's scope record first, the WSTG plan
 * second — so a report states what was tested without anyone retyping it. The
 * remaining lines are optional: an engagement that recorded no client prints no
 * client line rather than a placeholder.
 */
function reportContext(
  session: SessionRecord,
  stats: ReportStats,
  generatedAt: Date,
): ReportHtmlContext {
  const plan = session.webAppTestPlan ?? null;
  const engagement = session.engagementContext ?? {};
  const meta = engagement.metadata ?? {};
  const trimmed = (value?: string) => {
    const text = (value ?? "").trim();
    return text || undefined;
  };

  return {
    target: trimmed(engagement.target) ?? trimmed(plan?.target),
    scope: trimmed(engagement.scope) ?? trimmed(plan?.scope),
    client: trimmed(meta.client),
    tester: trimmed(meta.tester),
    testingWindow: trimmed(meta.testingWindow),
    version: trimmed(meta.version),
    limitations: trimmed(meta.limitations),
    generatedAt,
    stats,
  };
}

/**
 * Fingerprint of everything the printed page depends on. The issue date is
 * included at day granularity only: a report is dated when it is issued, so a
 * second export the same day reuses the file instead of re-rendering it.
 */
function pdfSignature(report: ClientReport, ctx: ReportHtmlContext): string {
  const day = ctx.generatedAt.toISOString().slice(0, 10);
  const { generatedAt: _ignored, ...rest } = ctx;
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ template: TEMPLATE_VERSION, day, report, ctx: rest }))
    .digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const inFlight = new Map<string, Promise<ReportPdfResult>>();

/**
 * The report as a PDF, stored beside the .docx.
 *
 * A Word-edited document wins: it is converted rather than re-rendered, because
 * the tester's rewrite is the report. `force` is the operator overruling that —
 * discard the edits and regenerate from the engagement's current results.
 *
 * Chromium is the only part that can fail in a deployment (no browser in the
 * image, no memory to start one); when it does, the .docx conversion is still
 * there, so an export never fails outright.
 */
export async function ensureReportPdf(
  sessionId: string,
  uid: unknown,
  options: { force?: boolean } = {},
): Promise<ReportPdfResult> {
  const key = `${sessionId}:${options.force === true ? "force" : "auto"}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = buildReportPdf(sessionId, uid, options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function buildReportPdf(
  sessionId: string,
  uid: unknown,
  options: { force?: boolean },
): Promise<ReportPdfResult> {
  const session = (await SessionsModel.findOne({ sessionId, uid })
    .select("name description createdAt vulnerabilities webAppTestPlan engagementContext")
    .lean()) as SessionRecord | null;
  if (!session) throw new Error("Session not found");

  const filePath = reportPdfPath(sessionId);
  const meta = readPdfMeta(sessionId);

  // The working document is (re)built first either way: it carries the model's
  // opening summary, and it is what a Word-edited export prints from.
  const docx = await ensureReportDocx(sessionId, uid, { force: options.force });

  if (!options.force && reportDocxStatus(sessionId).editedByWord) {
    const fileName = pdfFileName(docx.fileName);
    // Converting the .docx is the slow path (Collabora, then LibreOffice), so
    // the file is reused for as long as the document behind it is unchanged.
    const stat = fs.statSync(docx.filePath);
    const stamp = `docx:${stat.mtimeMs}:${stat.size}`;
    if (fs.existsSync(filePath) && meta.signature === stamp) {
      return { filePath, fileName, source: "docx" };
    }
    const pdf = await convertReportToPdf(docx.filePath);
    fs.writeFileSync(filePath, pdf);
    fs.writeFileSync(pdfMetaPath(sessionId), JSON.stringify({ signature: stamp, fileName }));
    return { filePath, fileName, source: "docx" };
  }

  const vulnerabilities = (session.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
  const testPlan = (session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
  const generatedAt = new Date();
  const stats = computeReportStats(buildReportFindings(vulnerabilities), testPlan);
  const ctx = reportContext(session, stats, generatedAt);

  const reportOptions: ReportOptions = {
    session: {
      sessionId,
      name: session.name ?? "Engagement",
      description: session.description ?? "",
      createdAt: session.createdAt,
    },
    summary: readReportSummary(sessionId),
    target: ctx.target,
    scope: ctx.scope,
    client: ctx.client,
    tester: ctx.tester,
    testingWindow: ctx.testingWindow,
    version: ctx.version,
    limitations: ctx.limitations,
    vulnerabilities,
    testPlan,
    generatedAt,
  };
  const report = buildClientReport(reportOptions);
  const signature = pdfSignature(report, ctx);
  const fileName = pdfFileName(report.fileName);

  if (!options.force && fs.existsSync(filePath) && meta.signature === signature) {
    return { filePath, fileName: meta.fileName ?? fileName, source: "html" };
  }

  let pdf: Buffer;
  try {
    pdf = await renderHtmlToPdf(buildReportHtml(report, ctx));
  } catch (err: any) {
    console.error("[report] html render failed, falling back to the .docx:", err?.message ?? err);
    pdf = await convertReportToPdf(docx.filePath);
    fs.writeFileSync(filePath, pdf);
    return { filePath, fileName, source: "docx" };
  }

  fs.writeFileSync(filePath, pdf);
  fs.writeFileSync(pdfMetaPath(sessionId), JSON.stringify({ signature, fileName, source: "html" }));
  return { filePath, fileName, source: "html" };
}
