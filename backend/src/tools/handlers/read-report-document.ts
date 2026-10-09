import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import { readReportDocument } from "../../services/web-security/report-docx.service";

/** The document is prose, not evidence: enough of it to answer, not all of it. */
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 60_000;

function clampMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(value), MAX_MAX_CHARS);
}

/** One finding card, from its "F-003 — title" heading to the next heading. */
function findingSection(text: string, code: string): string | undefined {
  const wanted = code.trim().toUpperCase();
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${wanted}\\b`).test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^F-\d{3}\b/.test(line));
  return lines.slice(start, end < 0 ? undefined : start + 1 + end).join("\n");
}

const readReportDocumentTool: ToolDefinition = {
  name: "read_report_document",
  description:
    "Read the text of this session's report document — the .docx the tester opens and edits in the Report page. " +
    "The document is authoritative once it has been saved from Word: it holds prose the tester rewrote, sections they deleted and wording no " +
    "finding field carries, so read it before answering anything about what the report says now (\"what does the summary claim?\", \"fix the " +
    "wording I changed\", \"is F-004 still in there?\") instead of inferring it from the tracked findings. " +
    "The header reports when the document was last written and whether it was hand-edited, so you can tell whether a Word edit has reached the " +
    "server yet. Pass finding_code to read a single finding card when the whole document is too long.",
  parameters: {
    type: "object",
    properties: {
      finding_code: {
        type: "string",
        description: 'Read only one finding card, e.g. "F-003" (case-insensitive).',
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
        return {
          output:
            `${lines.join("\n")}No finding "${args.finding_code}" is in the document. The cards present are:\n` +
            document.text
              .split("\n")
              .filter((line) => /^F-\d{3}\b/.test(line))
              .join("\n"),
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
