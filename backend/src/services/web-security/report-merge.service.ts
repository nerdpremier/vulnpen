/**
 * The tester's edits, in the designed layout.
 *
 * The report is edited in Word, but Word cannot express the design: no
 * full-bleed cover, no table of contents with real page numbers, no one card
 * per finding. Printing the .docx therefore throws the layout away, and
 * rendering the template throws the edits away — the two documents the product
 * can produce are each missing half of the report.
 *
 * This module is the bridge between them. The .docx is a flat text projection
 * of exactly the fields the cards are built from, so its text can be read back
 * and laid over the report content before the template renders: the prose the
 * tester rewrote, in the document the client was promised.
 *
 * What it cannot do is restructure. A card the tester deleted, a section
 * renamed to a label this parser does not know, a finding written by hand —
 * none of those exist in the engagement, so they do not exist in the PDF
 * either. Cards are matched by position (the .docx was generated from this very
 * body); when the card count no longer agrees, by title.
 *
 * Everything the document does not mention keeps its generated value, so a
 * partial edit — three findings polished, the rest left alone — still prints
 * all three as written and the rest as the engagement recorded them.
 */
import {
  bandFor,
  type ClientBlock,
  type ClientFinding,
  type ClientReport,
  type ThaiLevel,
} from "./client-report.service";
import { maskSensitive, type Severity } from "./report.service";

/** The sections of a finding card, in the order the document prints them. */
type Section = "discovered" | "steps" | "evidence" | "impact" | "recommendations";

/**
 * The labels that open a section inside a card. Both spellings of the last two
 * are listed: the .docx writes "รายละเอียดผลกระทบ" and "แนวทางแก้ไข และคำแนะนำ",
 * the HTML card heads them "ผลกระทบ" and "แนวทางแก้ไขและคำแนะนำ", and a tester
 * may well be reading either.
 */
const SECTION_LABELS: Record<string, Section> = {
  "สิ่งที่ตรวจพบ": "discovered",
  "ขั้นตอนการทดสอบ": "steps",
  "หลักฐานการทดสอบ": "evidence",
  "รายละเอียดผลกระทบ": "impact",
  "ผลกระทบ": "impact",
  "แนวทางแก้ไข และคำแนะนำ": "recommendations",
  "แนวทางแก้ไขและคำแนะนำ": "recommendations",
};

/** The attribute rows at the top of a card, matched on the label's opening. */
const DETAIL_LABELS: Array<[RegExp, "owasp" | "goal" | "cwe" | "cve" | "discoveredOn"]> = [
  [/^OWASP/i, "owasp"],
  [/^อ้างอิงเคสทดสอบ/, "goal"],
  [/^CWE\b/i, "cwe"],
  [/^CVE\b/i, "cve"],
  [/^วันที่ค้นพบ/, "discoveredOn"],
];

/**
 * What the document prints where a value is missing. Reading these back as a
 * value would overwrite a real one with a placeholder — and since the
 * placeholder is what the template prints anyway, skipping them loses nothing.
 */
const PLACEHOLDER = new Set(["", "—", "-", "–", "ไม่ได้บันทึก", "ไม่ได้ประเมิน", "ยังไม่จัดหมวดหมู่"]);

const THAI_LEVELS = new Set<ThaiLevel>([
  "วิกฤต",
  "สูง",
  "ปานกลาง",
  "ต่ำ",
  "ข้อมูลข่าวสาร",
  "ไม่ได้ประเมิน",
]);

const SEVERITY_OF: Record<ThaiLevel, Severity | undefined> = {
  "วิกฤต": "critical",
  "สูง": "high",
  "ปานกลาง": "medium",
  "ต่ำ": "low",
  "ข้อมูลข่าวสาร": "info",
  "ไม่ได้ประเมิน": undefined,
};

export interface ReportMerge {
  /** The report with the document's wording laid over it. */
  report: ClientReport;
  /** Counts per band, recomputed from the merged cards. */
  bySeverity: Record<Severity, number>;
  /** Cards read out of the document, and cards it had that could not be placed. */
  merged: number;
  unplaced: number;
}

interface ParsedCard {
  title: string;
  fields: Partial<ClientFinding>;
}

const cells = (line: string): string[] => line.split("|").map((cell) => cell.trim());

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

function thaiLevel(value: string): ThaiLevel | undefined {
  const text = value.trim();
  return THAI_LEVELS.has(text as ThaiLevel) ? (text as ThaiLevel) : undefined;
}

/**
 * One card, from its title to the last line before the next one. The label
 * lines are the structure: whatever follows one belongs to that section, which
 * is why a bullet whose text happens to contain a pipe still lands in the right
 * place instead of being read as an attribute.
 */
function parseCard(title: string, body: string[]): ParsedCard {
  const fields: Partial<ClientFinding> = { title };
  const buckets: Record<Section, string[]> = {
    discovered: [],
    steps: [],
    evidence: [],
    impact: [],
    recommendations: [],
  };
  const seen = new Set<Section>();
  let section: Section | null = null;

  for (let index = 0; index < body.length; index++) {
    const line = body[index];
    if (!line) continue;

    const label = SECTION_LABELS[line];
    if (label) {
      section = label;
      seen.add(label);
      continue;
    }

    // The risk strip: a header row, then the three values under it.
    if (/^ระดับความเสี่ยง\s*\|/.test(line) && /CVSS/.test(line)) {
      const values = cells(body[index + 1] ?? "");
      if (values.length >= 3) {
        fields.risk = thaiLevel(values[0]);
        if (!PLACEHOLDER.has(values[1])) fields.cvssScore = values[1];
        if (!PLACEHOLDER.has(values[2])) fields.cvssVector = values[2];
        index += 1;
      }
      section = null;
      continue;
    }

    const cut = line.indexOf("|");
    if (cut > 0) {
      const key = line.slice(0, cut).trim();
      const value = line.slice(cut + 1).trim();
      const field = DETAIL_LABELS.find(([pattern]) => pattern.test(key))?.[1];
      if (field) {
        if (!PLACEHOLDER.has(value)) fields[field] = value;
        section = null;
        continue;
      }
    }

    if (section) buckets[section].push(line);
  }

  // A section is only overridden when the document actually has it: an empty
  // bucket for a label that was never printed means "not mentioned", not "the
  // tester deleted every line".
  if (seen.has("discovered")) fields.discovered = buckets.discovered;
  if (seen.has("steps")) fields.steps = buckets.steps;
  if (seen.has("impact")) fields.impactDetails = buckets.impact;
  if (seen.has("recommendations")) fields.recommendations = buckets.recommendations;
  if (seen.has("evidence")) fields.evidence = buckets.evidence.join("\n");

  return { title, fields };
}

/**
 * The cards in document order, and the front matter above the first one.
 * A card opens with its title, and the line under it is always the OWASP
 * attribute row — that pair is a more reliable marker than the section heading,
 * which a tester may have renamed. The row is recognised by its pipe, not just
 * its first word: an engagement called "OWASP WebGoat" opens the document with
 * a line that starts the same way.
 */
function readCards(lines: string[]): { cards: ParsedCard[]; head: string[] } {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const next = lines[index + 1] ?? "";
    if (lines[index] && /^OWASP/i.test(next) && next.includes("|")) starts.push(index);
  }
  const cards = starts.map((start, position) =>
    parseCard(lines[start], lines.slice(start + 1, starts[position + 1] ?? lines.length)),
  );
  return { cards, head: lines.slice(0, starts[0] ?? lines.length) };
}

/** The report title, the engagement line, and the summary paragraphs. */
function readHead(
  head: string[],
  report: ClientReport,
): { title?: string; subtitle?: string; summary: string[] } {
  const lines = head.filter((line) => line.length > 0);
  if (!lines.length) return { summary: [] };

  // The counts table and the section heading end the front matter; everything
  // between the subtitle and them is the summary the tester read first.
  const counts = lines.findIndex((line) => /^ระดับความเสี่ยง\s*\|/.test(line) && !/CVSS/.test(line));
  const heading = lines.findIndex((line) => line === "รายละเอียดช่องโหว่ที่ตรวจพบ");
  const stop = counts >= 0 ? counts : heading;
  const top = stop >= 0 ? lines.slice(0, stop) : lines;

  const title = top[0];
  const subtitle = top[1] && (top[1] === report.subtitle || top[1].includes("—")) ? top[1] : undefined;
  return { title, subtitle, summary: top.slice(subtitle ? 2 : 1) };
}

/** Position first — the document was generated from this very body. */
function matchCards(cards: ParsedCard[], findings: ClientFinding[]): Map<string, Partial<ClientFinding>> {
  const patches = new Map<string, Partial<ClientFinding>>();
  if (!cards.length || !findings.length) return patches;

  if (cards.length === findings.length) {
    cards.forEach((card, index) => patches.set(findings[index].code, card.fields));
    return patches;
  }

  const byTitle = new Map(findings.map((finding) => [normalise(finding.title), finding]));
  for (const card of cards) {
    const target = byTitle.get(normalise(card.title));
    if (target) patches.set(target.code, card.fields);
  }
  return patches;
}

/** Replace the opening paragraphs, keeping the blocks around them. */
function withSummary(body: ClientBlock[], paragraphs: string[]): ClientBlock[] {
  if (!paragraphs.length) return body;
  const first = body.findIndex((block) => block.type === "p");
  if (first < 0) return body;
  let last = first;
  while (body[last + 1]?.type === "p") last += 1;
  return [
    ...body.slice(0, first),
    ...paragraphs.map((text) => ({ type: "p" as const, text })),
    ...body.slice(last + 1),
  ];
}

const findingsOf = (body: ClientBlock[]): ClientFinding[] =>
  body
    .filter((block): block is Extract<ClientBlock, { type: "finding" }> => block.type === "finding")
    .map((block) => block.finding);

/**
 * Counts per band, from the cards as they now read. A card whose risk the
 * tester changed moves between bands — and the cover, the summary tiles, the
 * bars and the remediation plan all read their numbers from here, so they move
 * with it instead of contradicting the card one page later.
 */
function countBands(findings: ClientFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    const severity = SEVERITY_OF[finding.risk];
    if (severity) counts[severity] += 1;
  }
  return counts;
}

/**
 * Lay the document's text over the report.
 *
 * A document that yields no cards leaves the report untouched and reports zero
 * merged: the caller decides what to do about it, and the honest answer there
 * is the .docx itself, not a template with the edits missing.
 */
export function mergeReportEdits(report: ClientReport, docxText: string): ReportMerge {
  const findings = findingsOf(report.body);
  const lines = String(docxText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const { cards, head } = readCards(lines);

  if (!cards.length) {
    return { report, bySeverity: countBands(findings), merged: 0, unplaced: 0 };
  }

  const patches = matchCards(cards, findings);
  const merged = report.body.map((block) => {
    if (block.type !== "finding") return block;
    const patch = patches.get(block.finding.code);
    if (!patch) return block;
    const finding: ClientFinding = { ...block.finding, ...patch };
    // The band is the card's colour; it follows the risk the document states.
    finding.band = bandFor(finding.risk);
    if (finding.evidence) finding.evidence = maskSensitive(finding.evidence);
    return { type: "finding" as const, finding };
  });

  const header = readHead(head, report);
  const body = withSummary(merged, header.summary);

  return {
    report: {
      ...report,
      title: header.title ?? report.title,
      subtitle: header.subtitle ?? report.subtitle,
      body,
    },
    bySeverity: countBands(findingsOf(body)),
    merged: patches.size,
    unplaced: cards.length - patches.size,
  };
}
