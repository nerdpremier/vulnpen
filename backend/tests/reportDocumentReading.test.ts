/**
 * Reading the report document back as text.
 *
 * The document is edited in Word, so its text is the only record of what the
 * report says after a hand edit — these tests pin the round trip (write a .docx
 * with the report builder, read it back) and the tool contract around it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClientReport } from "../src/services/web-security/client-report.service";
import { buildReportDocx } from "../src/services/web-security/report-docx.service";
import { extractDocxText } from "../src/services/web-security/docx-text.service";
import readReportDocument from "../src/tools/handlers/read-report-document";
import type { ExecutionContext } from "../src/tools/types";
import { normalizeVulnerability } from "../src/services/vulnerability.service";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnpen-report-read-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

test.after(() => {
  process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixtures() {
  return [
    normalizeVulnerability(
      {
        vulnerabilityId: "vuln_sqli",
        title: "Unauthenticated SQL injection in product search",
        target: "shop.example.test",
        endpoint: "GET https://shop.example.test/api/products?q=",
        av: "N",
        ac: "L",
        pr: "N",
        ui: "N",
        s: "U",
        c: "H",
        i: "H",
        a: "H",
        cwe: "CWE-89",
        wstgId: "WSTG-INPV-05",
        evidence: "q=' returned SQLSTATE syntax error.",
        stepsToReproduce: "Send GET /api/products?q=' and observe the SQL error",
        impact: "Full read access to the product database.",
        remediation: "Use parameterised queries.",
      },
      { source: "agent" },
    ),
    normalizeVulnerability({
      vulnerabilityId: "vuln_banner",
      title: "Verbose Server banner",
      target: "shop.example.test",
      severity: "low",
    }),
  ];
}

async function writeReport(sessionId: string, summary: string, editedByWord: boolean) {
  const report = buildClientReport({
    session: { sessionId, name: "Shop review" },
    summary,
    vulnerabilities: fixtures(),
    generatedAt: new Date("2026-02-01T00:00:00.000Z"),
  });
  const dir = path.join(dataDir, "reports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.docx`), await buildReportDocx(report));
  fs.writeFileSync(
    path.join(dir, `${sessionId}.meta.json`),
    JSON.stringify({ signature: "sig", editedByWord, fileName: report.fileName, summary }),
  );
  return report;
}

const context = (sessionId: string) => ({ sessionId }) as ExecutionContext;

test("a .docx round-trips to readable text: paragraphs, table rows and findings", async () => {
  const report = await writeReport("sess-round-trip", "บทสรุปที่ผู้ทดสอบแก้เองใน Word", false);
  const text = extractDocxText(fs.readFileSync(path.join(dataDir, "reports", "sess-round-trip.docx")));

  assert.ok(text.includes("รายงานช่องโหว่"), "the title survives");
  assert.ok(text.includes("Shop review — สรุปช่องโหว่ที่ตรวจพบ"), "the subtitle survives");
  assert.ok(text.includes("บทสรุปที่ผู้ทดสอบแก้เองใน Word"), "the summary survives");
  assert.ok(
    text.includes("ระดับความเสี่ยง | จำนวนช่องโหว่ที่ตรวจพบ"),
    `table cells are separated: ${text.slice(0, 400)}`,
  );
  assert.ok(text.includes("F-001 — Unauthenticated SQL injection in product search"), "finding headings survive");
  assert.ok(text.includes("Use parameterised queries."), "the card body survives");
  assert.ok(text.includes("CWE-89"), "list content survives");
  assert.ok(!text.includes("<w:"), "no markup is left in the text");
  assert.equal(report.body.length > 0, true);
});

test("the tool returns the document's own words and says where they came from", async () => {
  await writeReport("sess-read", "บทสรุปที่ผู้ทดสอบแก้เองใน Word", true);
  const result = await readReportDocument.execute({}, context("sess-read"));

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes("Source: hand-edited and saved in Word"), result.output.slice(0, 300));
  assert.ok(result.output.includes("Last written: 20"), "the header carries the document's timestamp");
  assert.ok(result.output.includes("บทสรุปที่ผู้ทดสอบแก้เองใน Word"));
  assert.ok(result.output.includes("F-001 — Unauthenticated SQL injection in product search"));
  // The stored document is what the report says — not what the findings imply.
  assert.ok(result.output.includes("CWE-89"));
});

test("a regenerated document is not described as hand-edited", async () => {
  await writeReport("sess-generated", "บทสรุปจากโมเดล", false);
  const result = await readReportDocument.execute({}, context("sess-generated"));
  assert.ok(result.output.includes("Source: generated from the tracked findings and test plan"));
});

test("one finding card can be read on its own", async () => {
  await writeReport("sess-card", "บทสรุปจากโมเดล", true);
  const result = await readReportDocument.execute({ finding_code: "f-002" }, context("sess-card"));

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes("F-002 — Verbose Server banner"), "the requested card is returned");
  assert.ok(!result.output.includes("F-001"), "and no other card");
  assert.ok(!result.output.includes("บทสรุปจากโมเดล"), "nor the summary");
});

test("a card that is not in the document is reported, with what is", async () => {
  await writeReport("sess-missing-card", "บทสรุปจากโมเดล", true);
  const result = await readReportDocument.execute({ finding_code: "F-009" }, context("sess-missing-card"));

  assert.ok(result.output.includes('No finding "F-009" is in the document'));
  assert.ok(result.output.includes("F-001"), "the cards that do exist are listed");
});

test("a long document is truncated at the limit, and says so", async () => {
  await writeReport("sess-long", "บทสรุปจากโมเดล", true);
  const result = await readReportDocument.execute({ max_chars: 120 }, context("sess-long"));

  assert.ok(result.output.includes("[truncated at 120 of"), result.output);
});

test("a session with no report yet is told how the report gets built", async () => {
  const result = await readReportDocument.execute({}, context("sess-never-opened"));

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes("no report document yet"));
  assert.ok(result.output.includes("generate_pentest_report"));
});

test("a session without one is not an error", async () => {
  const result = await readReportDocument.execute({}, { sessionId: "" } as ExecutionContext);
  assert.equal(result.exitCode, 1);
});
