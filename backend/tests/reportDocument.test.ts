/**
 * The report document, and the one part of it a model writes.
 *
 * The document is what a client reads, so these tests pin its shape: the
 * summary first, the counts, then the findings — and none of the boilerplate
 * chapters the document deliberately no longer carries.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildClientReport, buildDraftReport, type ClientBlock } from "../src/services/web-security/client-report.service";
import { buildReportDocx } from "../src/services/web-security/report-docx.service";
import { generateReportSummary } from "../src/services/web-security/report-summary.service";
import { normalizeVulnerability } from "../src/services/vulnerability.service";

function fixtures() {
  const sqli = normalizeVulnerability(
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
      exploited: true,
    },
    { source: "agent" },
  );
  const banner = normalizeVulnerability({
    vulnerabilityId: "vuln_banner",
    title: "Verbose Server banner",
    target: "shop.example.test",
    severity: "low",
  });
  return [sqli, banner];
}

const options = (summary?: string) => ({
  session: { sessionId: "sess-1", name: "Shop review" },
  summary,
  vulnerabilities: fixtures(),
  generatedAt: new Date("2026-02-01T00:00:00.000Z"),
});

const text = (blocks: ClientBlock[]): string =>
  blocks
    .map((block) =>
      block.type === "finding"
        ? [
            `${block.finding.code} ${block.finding.title} ${block.finding.risk} ${block.finding.cvssScore ?? ""}`,
            block.finding.discovered.join(" "),
            block.finding.impactDetails.join(" "),
            block.finding.recommendations.join(" "),
            block.finding.references.join(" "),
            block.finding.evidence,
          ].join(" ")
        : block.type === "table"
          ? `${block.headers.join(" ")} ${block.rows.flat().join(" ")}`
          : block.type === "bullets" || block.type === "numbers"
            ? block.items.join(" ")
            : block.text,
    )
    .join("\n");

test("the report opens with the model's summary, then the counts, then the findings", () => {
  const report = buildClientReport(options("พบช่องโหว่ทั้งหมด 2 รายการ\n\nควรแก้ไข SQL injection ก่อน"));

  assert.equal(report.title, "รายงานช่องโหว่");
  assert.equal(report.subtitle, "Shop review — สรุปช่องโหว่ที่ตรวจพบ");
  // One block per paragraph the model returned, in order, ahead of everything.
  assert.deepEqual(report.body.slice(0, 2), [
    { type: "p", text: "พบช่องโหว่ทั้งหมด 2 รายการ" },
    { type: "p", text: "ควรแก้ไข SQL injection ก่อน" },
  ]);
  assert.equal(report.body[2].type, "table");
  assert.equal(report.body[3].type, "h1");

  const rendered = text(report.body);
  assert.ok(rendered.includes("พบช่องโหว่ทั้งหมด 2 รายการ"), "the model's words are the summary");
  assert.ok(rendered.includes("Unauthenticated SQL injection in product search"), "findings carry their own title");
  assert.ok(rendered.includes("Use parameterised queries."), "the recorded remediation is rendered");
  assert.ok(rendered.includes("CWE-89"), "the references the finding maps to are rendered");
});

test("the report carries only the summary and the findings", () => {
  const rendered = text(buildClientReport(options("บทสรุปจากโมเดล")).body);

  for (const gone of [
    "หลักการและเหตุผล",
    "วัตถุประสงค์",
    "เป้าหมายของโครงการ",
    "บทนำ",
    "แนวทางในการดำเนินงาน",
    "เครื่องมือที่ใช้ในการทดสอบ",
    "เกณฑ์การให้ระดับความเสี่ยง",
    "รายละเอียดเอกสาร",
    "รายละเอียดคำย่อในเอกสาร",
    "ประวัติเอกสาร",
    "รายชื่อผู้ตรวจสอบระบบ",
    "เงื่อนไขการใช้งานและลิขสิทธิ์ทางปัญญา",
    "สารบัญ",
    "ผู้ว่าจ้าง",
    "จัดทำโดย",
  ]) {
    assert.ok(!rendered.includes(gone), `the report no longer carries "${gone}"`);
  }
  assert.ok(rendered.includes("ระดับความเสี่ยง"), "the risk counts stay");
  assert.ok(rendered.includes("รายละเอียดช่องโหว่ที่ตรวจพบ"), "the findings section stays");
});

test("a report without a summary states its own counts instead", () => {
  const rendered = text(buildClientReport(options(undefined)).body);

  assert.ok(rendered.includes("จำนวน 2 รายการ"), "the fallback sentence counts the findings");
  assert.ok(rendered.includes("รายละเอียดช่องโหว่ที่ตรวจพบ"));
});

test("an empty summary falls back rather than leaving the report headless", () => {
  const rendered = text(buildClientReport(options("   \n  ")).body);
  assert.ok(rendered.includes("จำนวน 2 รายการ"));
});

test("the draft is the same document without the model's summary", () => {
  const draft = buildDraftReport({ ...options("บทสรุปจากโมเดล"), vulnerabilities: fixtures() });

  assert.equal(draft.title, "รายงานช่องโหว่ (ฉบับร่าง)");
  assert.ok(draft.fileName.endsWith("-draft.docx"), draft.fileName);
  assert.ok(!text(draft.body).includes("บทสรุปจากโมเดล"), "the draft carries no model prose");
  assert.ok(text(draft.body).includes("Unauthenticated SQL injection in product search"));
});

test("the docx renders the report it is handed", async () => {
  const buffer = await buildReportDocx(buildClientReport(options("บทสรุปจากโมเดล")));
  assert.ok(buffer.length > 5000, `expected a real document, got ${buffer.length} bytes`);
  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK", "a .docx is a zip container");
});

test("the summary is written from the findings, never invented", async () => {
  const seen: Array<{ role: string; content: string }> = [];
  const summary = await generateReportSummary(
    {
      sessionName: "Shop review",
      findings: [
        {
          id: "vuln_sqli",
          index: 1,
          title: "Unauthenticated SQL injection in product search",
          severity: "critical",
          host: "shop.example.test",
          exploited: true,
          mappingRationale: "",
          relatedOwasp: [],
        },
      ],
      stats: {
        totalFindings: 1,
        bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
        exploited: 1,
        unmapped: 0,
        byOwasp: [],
        coverage: { total: 0, executed: 0, passed: 0, failed: 0, notStarted: 0, percentExecuted: 0 },
      },
    },
    {
      userId: "user-1",
      sessionId: "sess-1",
      deps: {
        resolveProvider: async () => ({ provider: "openai", model: "gpt-test" }) as never,
        invoke: async (request) => {
          seen.push(...(request.messages as Array<{ role: string; content: string }>));
          return { content: "  พบช่องโหว่ระดับวิกฤต 1 รายการ  " };
        },
      },
    },
  );

  assert.equal(summary, "พบช่องโหว่ระดับวิกฤต 1 รายการ", "the model's words are trimmed and kept");
  const brief = JSON.parse(seen[1].content);
  assert.equal(brief.counts.critical, 1, "the summary is briefed with the computed counts");
  assert.equal(brief.findings[0].title, "Unauthenticated SQL injection in product search");
  assert.ok(!("evidence" in brief.findings[0]), "raw evidence is not needed to write the summary");
  assert.ok(
    seen[0].content.includes("Never invent a finding"),
    "the prompt forbids inventing findings",
  );
});

test("a model that fails leaves the document to write its own summary", async () => {
  const input = {
    sessionName: "Shop review",
    findings: [
      {
        id: "vuln_sqli",
        index: 1,
        title: "SQL injection",
        severity: "critical" as const,
        host: "shop.example.test",
        exploited: false,
        mappingRationale: "",
        relatedOwasp: [],
      },
    ],
    stats: {
      totalFindings: 1,
      bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      exploited: 0,
      unmapped: 0,
      byOwasp: [],
      coverage: { total: 0, executed: 0, passed: 0, failed: 0, notStarted: 0, percentExecuted: 0 },
    },
  };

  const threw = await generateReportSummary(input, {
    userId: "user-1",
    deps: {
      resolveProvider: async () => {
        throw new Error("no model configured");
      },
      invoke: async () => ({ content: "unreachable" }),
    },
  });
  assert.equal(threw, undefined, "an unconfigured provider is not an error");

  const empty = await generateReportSummary(input, {
    userId: "user-1",
    deps: {
      resolveProvider: async () => ({ provider: "openai", model: "gpt-test" }) as never,
      invoke: async () => ({ content: "   " }),
    },
  });
  assert.equal(empty, undefined, "an empty reply is not a summary");
});

test("a report with no findings asks no model to summarise it", async () => {
  let called = false;
  const summary = await generateReportSummary(
    {
      sessionName: "Shop review",
      findings: [],
      stats: {
        totalFindings: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        exploited: 0,
        unmapped: 0,
        byOwasp: [],
        coverage: { total: 0, executed: 0, passed: 0, failed: 0, notStarted: 0, percentExecuted: 0 },
      },
    },
    {
      userId: "user-1",
      deps: {
        resolveProvider: async () => ({ provider: "openai", model: "gpt-test" }) as never,
        invoke: async () => {
          called = true;
          return { content: "x" };
        },
      },
    },
  );

  assert.equal(summary, undefined);
  assert.equal(called, false, "there is nothing to summarise");
});
