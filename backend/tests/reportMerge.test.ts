/**
 * Reading the tester's Word edits back into the designed report.
 *
 * The PDF is laid out from the report content, not from the .docx, so an edit
 * made in Word only reaches it if the document's text can be read back onto
 * that content. These tests pin that round trip against the real writer: build
 * the report, print it to .docx, read the text back, and check that nothing
 * moves — then that an edit does.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildClientReport, type ClientFinding, type ClientReport } from "../src/services/web-security/client-report.service";
import { buildReportDocx } from "../src/services/web-security/report-docx.service";
import { extractDocxText } from "../src/services/web-security/docx-text.service";
import { mergeReportEdits } from "../src/services/web-security/report-merge.service";
import { normalizeVulnerability } from "../src/services/vulnerability.service";

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
      remediation: "Suppress the Server header.",
    }),
  ];
}

function buildReport(): ClientReport {
  return buildClientReport({
    session: { sessionId: "sess-merge", name: "Shop review" },
    summary: "บทสรุปจากโมเดล",
    vulnerabilities: fixtures(),
    generatedAt: new Date("2026-02-01T00:00:00.000Z"),
  });
}

/** The document the tester would open, as the text they would edit. */
async function documentText(report: ClientReport): Promise<string> {
  return extractDocxText(await buildReportDocx(report));
}

const cards = (report: ClientReport): ClientFinding[] =>
  report.body
    .filter((block): block is Extract<ClientReport["body"][number], { type: "finding" }> => block.type === "finding")
    .map((block) => block.finding);

const summaryOf = (report: ClientReport): string[] =>
  report.body.filter((block) => block.type === "p").map((block) => block.text);

/** Replace one line, asserting it was there — an edit that silently misses
 *  would leave the test passing for the wrong reason. */
function replaceLine(text: string, match: string, next: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(match));
  assert.ok(index >= 0, `the document has no line containing ${JSON.stringify(match)}`);
  lines[index] = next;
  return lines.join("\n");
}

/** Remove the lines between one label and the next, the way Word does when a
 *  tester deletes a block of bullets. */
function removeBetween(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === from);
  const end = lines.findIndex((line, index) => index > start && line === to);
  assert.ok(start >= 0 && end > start, `no ${from} … ${to} block`);
  return [...lines.slice(0, start + 1), ...lines.slice(end)].join("\n");
}

test("the document round-trips into the report it was generated from", async () => {
  const report = buildReport();
  const merge = mergeReportEdits(report, await documentText(report));

  assert.equal(merge.merged, cards(report).length, "every card is matched");
  assert.equal(merge.unplaced, 0);
  assert.deepEqual(cards(merge.report), cards(report), "no field moves on a document nobody edited");
  assert.deepEqual(summaryOf(merge.report), summaryOf(report));
  assert.equal(merge.report.subtitle, report.subtitle);
});

test("an edit in Word is what the designed report says", async () => {
  const report = buildReport();
  let text = await documentText(report);

  text = replaceLine(text, "Use parameterised queries.", "Use parameterised queries, and never concatenate SQL.");
  text = replaceLine(text, "Send GET /api/products?q=", "Send GET /api/products?q=' (no quoting) and watch the error");
  text = replaceLine(text, "q=' returned SQLSTATE", "q=' returned: SQLSTATE[42000] syntax error near '''");
  text = replaceLine(text, "Unauthenticated SQL injection in product search", "SQL injection in the product search endpoint");

  const merge = mergeReportEdits(report, text);
  const [first] = cards(merge.report);

  assert.equal(first.title, "SQL injection in the product search endpoint");
  assert.deepEqual(first.recommendations, ["Use parameterised queries, and never concatenate SQL."]);
  assert.deepEqual(first.steps, ["Send GET /api/products?q=' (no quoting) and watch the error"]);
  assert.equal(first.evidence, "q=' returned: SQLSTATE[42000] syntax error near '''");
  // Everything the document still says is untouched.
  assert.equal(first.cwe, "CWE-89");
  assert.equal(first.impactDetails[0], "Full read access to the product database.");
});

test("a section the tester emptied is empty in the report, not restored", async () => {
  const report = buildReport();
  const text = removeBetween(
    await documentText(report),
    "แนวทางแก้ไข และคำแนะนำ",
    "Verbose Server banner",
  );

  const [first] = cards(mergeReportEdits(report, text).report);
  assert.deepEqual(first.recommendations, []);
});

/** Rewrite the risk strip of the first card: level, score and vector. */
function replaceRiskRow(text: string, next: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith("ระดับความเสี่ยง | คะแนนฐาน"));
  assert.ok(index >= 0, "the document has no risk strip");
  lines[index + 1] = next;
  return lines.join("\n");
}

test("the counts follow the risk the document states", async () => {
  const report = buildReport();
  const untouched = await documentText(report);
  const before = mergeReportEdits(report, untouched).bySeverity;

  const text = replaceRiskRow(
    untouched,
    "ต่ำ | 3.1 | CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  );

  const merge = mergeReportEdits(report, text);
  const [first] = cards(merge.report);
  assert.equal(first.risk, "ต่ำ");
  assert.equal(first.cvssScore, "3.1");
  assert.equal(first.band, "yellow", "the card's colour follows the level");
  assert.equal(merge.bySeverity.critical, before.critical - 1);
  assert.equal(merge.bySeverity.low, before.low + 1);
});

test("a deleted card does not shift the ones under it", async () => {
  const report = buildReport();
  const lines = (await documentText(report)).split("\n");
  const start = lines.findIndex((line) => line === "Unauthenticated SQL injection in product search");
  const end = lines.findIndex((line) => line === "Verbose Server banner");
  assert.ok(start >= 0 && end > start);
  const text = [...lines.slice(0, start), ...lines.slice(end)].join("\n");

  const merge = mergeReportEdits(report, text);
  assert.equal(merge.merged, 1, "only the surviving card is applied");
  assert.equal(merge.unplaced, 0);
  assert.equal(cards(merge.report)[1].title, "Verbose Server banner", "the second card stays itself");
});

test("a document that yields no cards leaves the report alone", () => {
  const report = buildReport();
  const merge = mergeReportEdits(report, "no cards here at all");

  assert.equal(merge.merged, 0);
  assert.equal(merge.report, report, "the caller gets the report back untouched");
});
