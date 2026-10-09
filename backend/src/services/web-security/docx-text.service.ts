/**
 * Reading a .docx back as text.
 *
 * The report is a Word document the tester edits in the Report page, so once it
 * has been saved the document — not the findings it was generated from — is
 * what it says. Reading it back needs no office service and no dependency: a
 * .docx is a zip whose `word/document.xml` holds the text, and both the `docx`
 * library that writes it here and LibreOffice that rewrites it in Collabora use
 * the same WordprocessingML, so one reader covers both.
 *
 * This is deliberately a text projection, not a document model: paragraphs,
 * table rows and cell separators are all the assistant needs to answer "what
 * does the report say now?".
 */

import zlib from "zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const MAX_COMMENT = 66_000;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT);
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/**
 * One member of the zip, inflated. Sizes come from the central directory, not
 * the local header: a streaming writer (LibreOffice) leaves the local sizes at
 * zero and puts the real ones in a trailing data descriptor.
 */
function zipEntry(buffer: Buffer, name: string): Buffer | undefined {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return undefined;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      return undefined;
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (entryName === name) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      return undefined;
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const code = Number(decimal);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    // Last, so an escaped "&amp;lt;" survives as text instead of becoming "<".
    .replace(/&amp;/g, "&");
}

/**
 * WordprocessingML to text. Only `<w:t>` runs are read, so field codes,
 * deleted revisions and drawing markup contribute nothing; a paragraph ends a
 * line, a table row ends a line, and cells within a row are separated by "|" so
 * a table stays legible.
 */
function documentXmlToText(xml: string): string {
  const lines: string[] = [];
  let current = "";
  let inText = false;
  let inCell = false;
  let cellHasText = false;

  const endParagraph = () => {
    if (inCell) {
      if (cellHasText) current += " ";
      return;
    }
    lines.push(current);
    current = "";
  };

  for (const token of xml.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<")) {
      if (/^<w:t[\s>]/.test(token)) inText = true;
      else if (token === "</w:t>") inText = false;
      else if (/^<w:tc[\s>]/.test(token)) {
        inCell = true;
        cellHasText = false;
      } else if (token === "</w:tc>") {
        inCell = false;
        current += " | ";
      } else if (token === "</w:p>" || token === "</w:tr>") endParagraph();
      else if (/^<w:br[\s/]/.test(token)) current += inCell ? " " : "\n";
      continue;
    }
    if (!inText) continue;
    current += decodeEntities(token);
    cellHasText = true;
  }
  endParagraph();

  const cleaned: string[] = [];
  for (const raw of lines.join("\n").split("\n")) {
    const line = raw
      .replace(/[ \t]+/g, " ")
      .replace(/(\s*\|\s*)+$/, "")
      .trim();
    if (!line) {
      if (cleaned.length && cleaned[cleaned.length - 1] !== "") cleaned.push("");
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").trim();
}

/** The document body as text, or "" when the file is not a readable .docx. */
export function extractDocxText(buffer: Buffer): string {
  try {
    const xml = zipEntry(buffer, "word/document.xml");
    return xml ? documentXmlToText(xml.toString("utf8")) : "";
  } catch {
    return "";
  }
}
