import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import { readReportDocument } from "../../services/web-security/report-docx.service";

/** The document is prose, not evidence: enough of it to answer, not all of it. */
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 60_000;

function clampMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(value), MAX_MAX_CHARS);
}

/**
 * The line that opens every finding card, right under its title heading. The
 * card carries no finding code any more — the client document prints none — so
 * cards are delimited by this label and addressed by their position, which is
 * the order the codes were assigned in.
 */
const CARD_OPEN = /^OWASP Top 10:2025\s*:/;

/** One finding card, from its title heading to the line before the next card. */
function cardSections(text: string): string[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (CARD_OPEN.test(line.trim())) starts.push(Math.max(0, index - 1));
  });
  return starts.map((start, index) =>
    lines.slice(start, index + 1 < starts.length ? starts[index + 1] : undefined).join("\n").trim(),
  );
}

/** "F-004" (case-insensitive) -> 4. Anything else is not a card reference. */
function cardNumber(code: string): number | undefined {
  const match = /^f-?(\d{1,3})$/i.exec(code.trim());
  return match ? Number(match[1]) : undefined;
}

function findingSection(text: string, code: string): string | undefined {
  const wanted = cardNumber(code);
  if (!wanted) return undefined;
  return cardSections(text)[wanted - 1];
}

const readReportDocumentTool: ToolDefinition = {
  name: "read_report_document",
  description:
    "Read the text of this session's report document — the .docx the tester opens and edits in the Report page. " +
    "The document is authoritative once it has been saved from Word: it holds prose the tester rewrote, sections they deleted and wording no " +
    "finding field carries, so read it before answering anything about what the report says now (\"what does the summary claim?\", \"fix the " +
    "wording I changed\", \"is the SQL injection finding still in there?\") instead of inferring it from the tracked findings. " +
    "The header reports when the document was last written and whether it was hand-edited, so you can tell whether a Word edit has reached the " +
    "server yet. Pass finding_code to read a single finding card when the whole document is too long.",
  parameters: {
    type: "object",
    properties: {
      finding_code: {
        type: "string",
        description:
          'Read one finding card by its position in the document, e.g. "F-003" for the third card (case-insensitive). The cards print no ' +
          "codes of their own — this is the order the findings appear in, which is also the order their F-numbers were assigned.",
      },
      max_chars: {
        type: "number",
        description: `Truncate the text at this many characters (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}).`,
      },
    },
    required: [],
  },
  timeoutMs: 20_000,
  async execute(args: Record<string, any>, ctx: ExecutionContext): Promise<ToolResult> {
    const sessionId = ctx.sessionId;
    if (!sessionId) return { output: "No session in context.", exitCode: 1 };

    const document = readReportDocument(sessionId);
    if (!document) {
      return {
        output:
          "This session has no report document yet: it is generated the first time the Report page is opened (or when a report export is " +
          "requested) from the tracked findings and the WSTG test plan. Read the findings instead, or build the report with " +
          "generate_pentest_report.",
        exitCode: 0,
      };
    }

    if (!document.text.trim()) {
      return {
        output: `The stored report (${document.fileName}) could not be read as text. Report it to the user rather than guessing at its contents.`,
        exitCode: 1,
      };
    }

    const provenance = document.editedByWord
      ? "hand-edited and saved in Word — the document is authoritative and the generator never overwrites it"
      : "generated from the tracked findings and test plan";

    const lines = [
      `# Report document: ${document.fileName}`,
      `Source: ${provenance}.`,
      `Last written: ${document.savedAt.toISOString()} (${document.bytes} bytes).`,
      "",
    ];

    let body = document.text;
    if (typeof args.finding_code === "string" && args.finding_code.trim()) {
      const section = findingSection(document.text, args.finding_code);
      if (!section) {
        const cards = cardSections(document.text);
        return {
          output:
            `${lines.join("\n")}No finding card "${args.finding_code}" is in the document. ` +
            `The document holds ${cards.length} card(s), in this order:\n` +
            cards.map((card, index) => `${index + 1}. ${card.split("\n")[0]}`).join("\n"),
          exitCode: 0,
        };
      }
      body = section;
    }

    const limit = clampMaxChars(args.max_chars);
    if (body.length > limit) {
      lines.push(body.slice(0, limit));
      lines.push(
        "",
        `[truncated at ${limit} of ${body.length} characters — read the rest with finding_code, or raise max_chars.]`,
      );
    } else {
      lines.push(body);
    }

    return { output: lines.join("\n"), exitCode: 0 };
  },
};

export default readReportDocumentTool;
