import { Request, Response } from "express";
import fs from "fs";
import SessionsModel, {
  SessionVulnerabilityDoc,
} from "../models/Sessions/Sessions.model";
import type { WebAppTestPlanDoc } from "../models/Sessions/Sessions.model";
import { requireActiveSession } from "../services/session.helpers";
import { saveSessionPlan } from "../services/web-security/session-plan-store";
import {
  cancelQueuedRun,
  enqueueRun,
  getRunDetail,
  listRuns,
  stopRun,
} from "../services/web-security/run-queue.service";
import { mapUnclassifiedVulnerabilities } from "../services/vulnerability.service";
import {
  addCatalogueCases,
  computeCoverage,
  createTestPlan,
  normalizeTestStatus,
  removeCase,
  removeCases,
  updateTestCase,
} from "../services/web-security/test-plan.service";
import {
  describeOwaspMapping,
  mapFindingToOwaspTop10,
} from "../services/web-security/owasp-mapping.service";
import { buildWebAppPentestReport } from "../services/web-security/report.service";
import { buildClientReport } from "../services/web-security/client-report.service";
import {
  convertReportToPdf,
  ensureReportDocx,
  markReportEditedByWord,
  reportDocxPath,
} from "../services/web-security/report-docx.service";
import { buildWordEditorUrl, resolveWopiToken } from "../services/web-security/wopi.service";
import {
  OWASP_TOP10_2025,
  OWASP_TOP10_2025_SOURCE,
  OWASP_TOP10_2025_VERSION,
  WSTG_CATEGORIES,
  WSTG_SOURCE,
  WSTG_TESTS,
  WSTG_VERSION,
  computeOwaspCoverage,
  getOwaspCategory,
} from "../knowledge";

function catalogPayload() {
  return {
    version: WSTG_VERSION,
    source: WSTG_SOURCE,
    totalTests: WSTG_TESTS.length,
    // Compact list for the "add test cases" picker: the full method text lives in the plan.
    tests: WSTG_TESTS.map((test) => ({
      id: test.id,
      section: test.section,
      category: test.category,
      title: test.title,
      objective: test.objective,
    })),
    categories: WSTG_CATEGORIES.map((category) => ({
      code: category.code,
      section: category.section,
      name: category.name,
      objective: category.objective,
      testCount: WSTG_TESTS.filter((test) => test.category === category.code).length,
    })),
  };
}

function planPayload(plan: WebAppTestPlanDoc | null) {
  return {
    plan,
    coverage: plan ? computeCoverage(plan.cases) : null,
    catalog: catalogPayload(),
  };
}

export const getTestPlan = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const refreshed = await SessionsModel.findOne({ sessionId, uid: userId })
      .select("webAppTestPlan")
      .lean();
    const plan = (refreshed?.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
    return res.status(200).json(planPayload(plan));
  } catch (err: any) {
    console.error("[web-security] test plan read error:", err);
    return res.status(500).json({ message: "Failed to load the WSTG test plan" });
  }
};

export const generateTestPlan = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const body = req.body ?? {};
    const existing =
      ((session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null) as WebAppTestPlanDoc | null;
    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

    // The page adds cases to a plan that already exists; only a plain call regenerates it.
    if (action === "add_case" || action === "add_cases") {
      if (!existing?.cases?.length) {
        return res
          .status(400)
          .json({ message: "Generate the WSTG test plan before adding test cases" });
      }

      const rawIds = [
        ...(Array.isArray(body.testIds) ? body.testIds : []),
        ...(Array.isArray(body.test_ids) ? body.test_ids : []),
        typeof body.testId === "string" ? body.testId : "",
      ].filter((testId): testId is string => typeof testId === "string" && !!testId.trim());

      if (!rawIds.length) {
        return res.status(400).json({
          message: 'testIds must list the WSTG cases to add, e.g. ["WSTG-INPV-05"]',
        });
      }

      const result = addCatalogueCases(existing, rawIds);
      if (!result.added.length) {
        const rejected = result.unknown.length && !result.skipped.length;
        return res.status(rejected ? 400 : 409).json({
          message: rejected
            ? `Not part of WSTG v${WSTG_VERSION}: ${result.unknown.join(", ")}`
            : `Already in the plan: ${result.skipped.join(", ")}`,
        });
      }

      await saveSessionPlan(sessionId, result.plan, { uid: userId });

      return res.status(200).json({
        ...planPayload(result.plan),
        added: result.added.map((testCase) => testCase.testId),
        skipped: result.skipped,
        unknown: result.unknown,
      });
    }



    if (action && action !== "generate") {
      return res.status(400).json({ message: `Unsupported test plan action: ${body.action}` });
    }
    const result = createTestPlan({
      target: typeof body.target === "string" ? body.target : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      categories: Array.isArray(body.categories) ? body.categories : undefined,
      testIds: Array.isArray(body.testIds)
        ? body.testIds
        : Array.isArray(body.test_ids)
          ? body.test_ids
          : undefined,
      existing,
    });

    await saveSessionPlan(sessionId, result.plan, { uid: userId });

    // Keep the engagement boundary in step with the plan: the scope gate reads
    // engagementContext, so "edit the plan later" must update it too.
    await SessionsModel.updateOne(
      { sessionId, uid: userId },
      {
        $set: {
          "engagementContext.target":
            typeof body.target === "string" ? body.target.trim() : "",
          "engagementContext.scope":
            typeof body.scope === "string" ? body.scope.trim() : "",
        },
      },
    );

    return res.status(200).json({
      ...planPayload(result.plan),
      added: result.added,
      kept: result.kept,
    });
  } catch (err: any) {
    console.error("[web-security] test plan generate error:", err);
    return res.status(500).json({ message: "Failed to generate the WSTG test plan" });
  }
};

export const updateTestCaseStatus = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, testId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const plan = (session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
    if (!plan?.cases?.length) {
      return res.status(404).json({ message: "No WSTG test plan exists for this session" });
    }

    const body = req.body ?? {};
    if (body.status !== undefined && !normalizeTestStatus(body.status)) {
      return res.status(400).json({ message: `Unsupported test status: ${body.status}` });
    }

    const updated = updateTestCase(plan, testId, {
      status: body.status,
      title: typeof body.title === "string" ? body.title : undefined,
      objective: typeof body.objective === "string" ? body.objective : undefined,
      howToTest: typeof body.howToTest === "string" ? body.howToTest : undefined,
      evidenceExpectation:
        typeof body.evidenceExpectation === "string" ? body.evidenceExpectation : undefined,
      tools: Array.isArray(body.tools)
        ? body.tools
            .filter((tool: unknown): tool is string => typeof tool === "string" && tool.trim().length > 0)
            .map((tool: string) => tool.trim())
        : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      observations: typeof body.observations === "string" ? body.observations : undefined,
      addLinkedVulnerabilityId:
        typeof body.vulnerabilityId === "string"
          ? body.vulnerabilityId
          : typeof body.vulnerability_id === "string"
            ? body.vulnerability_id
            : undefined,
    });
    if (!updated) {
      return res.status(404).json({ message: `${testId} is not part of this test plan` });
    }

    await saveSessionPlan(sessionId, updated.plan, { uid: userId });

    return res.status(200).json({
      testCase: updated.testCase,
      coverage: computeCoverage(updated.plan.cases),
      plan: updated.plan,
    });
  } catch (err: any) {
    console.error("[web-security] test case update error:", err);
    return res.status(500).json({ message: "Failed to update the test case" });
  }
};

export const removeTestCase = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, testId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const plan = (session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
    if (!plan?.cases?.length) {
      return res.status(404).json({ message: "No WSTG test plan exists for this session" });
    }

    const removed = removeCase(plan, testId);
    if (!removed) {
      return res.status(404).json({ message: `${testId} is not part of this test plan` });
    }

    await saveSessionPlan(sessionId, removed.plan, { uid: userId });

    return res.status(200).json({
      testId: removed.testId,
      coverage: computeCoverage(removed.plan.cases),
      plan: removed.plan,
    });
  } catch (err: any) {
    console.error("[web-security] test case remove error:", err);
    return res.status(500).json({ message: "Failed to remove the test case" });
  }
};

export const removeTestCases = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const plan = (session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
    if (!plan?.cases?.length) {
      return res.status(404).json({ message: "No WSTG test plan exists for this session" });
    }

    const body = req.body ?? {};
    const category = typeof body.category === "string" ? body.category.trim().toUpperCase() : "";
    const requested: unknown[] = Array.isArray(body.testIds) ? body.testIds : [];

    // Clearing a whole WSTG category and unticking a few rows are the same delete in the
    // UI, so both shapes land here.
    const testIds = requested.length
      ? requested
      : plan.cases
          .filter(
            (testCase) =>
              !!category && String(testCase.categoryCode ?? "").toUpperCase() === category,
          )
          .map((testCase) => testCase.testId);

    if (!testIds.length) {
      return res
        .status(400)
        .json({ message: "Provide testIds to remove, or the category to clear" });
    }

    const removed = removeCases(plan, testIds);
    if (!removed) {
      return res
        .status(404)
        .json({ message: "None of these test cases are part of this plan" });
    }

    await saveSessionPlan(sessionId, removed.plan, { uid: userId });

    return res.status(200).json({
      ...planPayload(removed.plan),
      removed: removed.removed,
    });
  } catch (err: any) {
    console.error("[web-security] test case bulk remove error:", err);
    return res.status(500).json({ message: "Failed to remove the test cases" });
  }
};

// ─── Nessus-style runs: launch WSTG cases from the web UI ────────────

export const launchTestRun = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const plan = (session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
    if (!plan?.cases?.length) {
      return res.status(404).json({ message: "No WSTG test plan exists for this session" });
    }

    const body = req.body ?? {};
    const requested: unknown[] = Array.isArray(body.testIds) ? body.testIds : [];
    const testIds = requested
      .filter((testId) => typeof testId === "string" && testId.trim())
      .map((testId) => String(testId).trim().toUpperCase());
    if (!testIds.length) {
      return res.status(400).json({ message: "testIds is required" });
    }

    const result = await enqueueRun({ sessionId, userId, testIds });
    if (!result.ok) {
      return res.status(404).json({
        message: "Some test cases are not part of this plan",
        missing: result.missing,
      });
    }

    return res.status(200).json({
      run: result.run,
      position: result.position,
      queued: result.position > 1,
    });
  } catch (err: any) {
    console.error("[web-security] launch test run error:", err);
    return res.status(500).json({ message: "Failed to launch the test run" });
  }
};

export const getTestRuns = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    return res.status(200).json({ runs: await listRuns(sessionId) });
  } catch (err: any) {
    console.error("[web-security] list test runs error:", err);
    return res.status(500).json({ message: "Failed to list the test runs" });
  }
};

export const getTestRunDetail = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, runId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const detail = await getRunDetail(sessionId, runId);
    if (!detail.run) {
      return res.status(404).json({ message: "Test run not found" });
    }

    return res.status(200).json(detail);
  } catch (err: any) {
    console.error("[web-security] test run detail error:", err);
    return res.status(500).json({ message: "Failed to load the test run" });
  }
};

export const stopTestRun = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, runId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const stopped = await stopRun(sessionId, runId);
    if (!stopped) {
      return res.status(409).json({ message: "The test run is not running or queued" });
    }

    return res.status(200).json({ runId, status: "cancelling" });
  } catch (err: any) {
    console.error("[web-security] stop test run error:", err);
    return res.status(500).json({ message: "Failed to stop the test run" });
  }
};

export const cancelTestRun = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, runId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const cancelled = await cancelQueuedRun(sessionId, runId);
    if (!cancelled) {
      return res.status(409).json({ message: "The test run is not queued" });
    }

    return res.status(200).json({ runId, status: "cancelled" });
  } catch (err: any) {
    console.error("[web-security] cancel test run error:", err);
    return res.status(500).json({ message: "Failed to cancel the test run" });
  }
};
export const getReport = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const refreshed = await SessionsModel.findOne({ sessionId, uid: userId })
      .select("name description createdAt vulnerabilities webAppTestPlan")
      .lean();
    if (!refreshed) return res.status(404).json({ message: "Session not found" });

    const reportOptions = {
      session: {
        sessionId,
        name: refreshed.name ?? "Engagement",
        description: refreshed.description ?? "",
        createdAt: refreshed.createdAt as unknown as Date,
      },
      vulnerabilities: (refreshed.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
      testPlan: (refreshed.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null,
    };
    const report = buildWebAppPentestReport(reportOptions);

    if (req.query.download === "1") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${report.fileName}"`,
      );
      return res.status(200).send(report.markdown);
    }

    return res.status(200).json({
      report: {
        title: report.title,
        fileName: report.fileName,
        generatedAt: report.generatedAt,
        markdown: report.markdown,
        stats: report.stats,
        findings: report.findings,
        client: buildClientReport(reportOptions),
      },
    });
  } catch (err: any) {
    console.error("[web-security] report error:", err);
    return res.status(500).json({ message: "Failed to generate the report draft" });
  }
};

export const getOwaspCoverage = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const refreshed = await SessionsModel.findOne({ sessionId, uid: userId })
      .select("vulnerabilities webAppTestPlan")
      .lean();
    const vulnerabilities = (refreshed?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
    const coverage = computeOwaspCoverage(vulnerabilities);
    const findingsByCategory = new Map(coverage.byOwasp.map((row) => [row.id, row.findings]));

    return res.status(200).json({
      framework: {
        version: OWASP_TOP10_2025_VERSION,
        source: OWASP_TOP10_2025_SOURCE,
        categories: OWASP_TOP10_2025.map((category) => ({
          id: category.id,
          rank: category.rank,
          title: category.title,
          summary: category.summary,
          cwes: category.cwes,
          wstgFocus: category.wstgFocus,
          findings: findingsByCategory.get(category.id) ?? 0,
        })),
      },
      totalFindings: coverage.total,
      unmappedFindings: coverage.unmapped,
    });
  } catch (err: any) {
    console.error("[web-security] owasp coverage error:", err);
    return res.status(500).json({ message: "Failed to load OWASP Top 10:2025 coverage" });
  }
};

export const mapVulnerability = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, vulnerabilityId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const target = (session.vulnerabilities ?? []).find(
      (vulnerability) => vulnerability.vulnerabilityId === vulnerabilityId,
    );
    if (!target) return res.status(404).json({ message: "Vulnerability not found" });

    const body = req.body ?? {};
    const apply = body.apply !== false;
    const mapping = mapFindingToOwaspTop10({
      title: body.title ?? target.title,
      description: body.description ?? target.description,
      contextSummary: target.contextSummary,
      evidence: body.evidence ?? target.evidence,
      endpoint: target.endpoint,
      service: target.service,
      cwe: body.cwe ?? target.cwe,
      wstgId: body.wstgId ?? body.wstg_id ?? target.wstgId,
      owaspTop10: body.owaspTop10 ?? body.owasp_top10 ?? target.owaspTop10,
    });

    let vulnerability = target;
    if (apply && mapping.primary) {
      const category = getOwaspCategory(mapping.primary);
      const { wstgId } = { wstgId: body.wstgId ?? body.wstg_id ?? target.wstgId };
      await SessionsModel.updateOne(
        { sessionId, uid: userId, "vulnerabilities.vulnerabilityId": vulnerabilityId },
        {
          $set: {
            "vulnerabilities.$.owaspTop10": mapping.primary,
            "vulnerabilities.$.owaspTop10Title": category?.title,
            "vulnerabilities.$.owaspRelated": mapping.related,
            "vulnerabilities.$.owaspConfidence": mapping.confidence,
            "vulnerabilities.$.owaspRationale": mapping.rationale,
            "vulnerabilities.$.owaspMappedAt": new Date(),
            "vulnerabilities.$.wstgId": wstgId,
            "vulnerabilities.$.updatedAt": new Date(),
          },
        },
      );
      vulnerability = {
        ...target,
        owaspTop10: mapping.primary,
        owaspTop10Title: category?.title,
        owaspRelated: mapping.related,
        owaspConfidence: mapping.confidence,
        owaspRationale: mapping.rationale,
        wstgId,
      } as SessionVulnerabilityDoc;
    }

    return res.status(200).json({
      mapping: { ...mapping, description: describeOwaspMapping(mapping) },
      applied: apply && !!mapping.primary,
      vulnerability,
    });
  } catch (err: any) {
    console.error("[web-security] vulnerability mapping error:", err);
    return res.status(500).json({ message: "Failed to map the vulnerability" });
  }
};

export const remapAllVulnerabilities = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const mapped = await mapUnclassifiedVulnerabilities(
      sessionId,
      (session.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
    );
    return res.status(200).json({ mapped });
  } catch (err: any) {
    console.error("[web-security] remap error:", err);
    return res.status(500).json({ message: "Failed to map the findings" });
  }
};
// ---------------------------------------------------------------------------
// LibreOffice / Collabora integration — the stored .docx is the working copy
// of the Thai report: downloaded, edited like Word (WOPI) and converted to PDF.
// ---------------------------------------------------------------------------
export const openReportWord = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    // Materialise the working document before Collabora asks for it.
    await ensureReportDocx(sessionId, userId);
    const editor = await buildWordEditorUrl(sessionId, String(userId));
    return res.status(200).json(editor);
  } catch (err: any) {
    console.error("[web-security] word editor error:", err);
    return res.status(500).json({ message: err?.message ?? "Failed to open the Word editor" });
  }
};

export const downloadReportDocxFile = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const { filePath, fileName } = await ensureReportDocx(sessionId, userId);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    return res.status(200).send(fs.readFileSync(filePath));
  } catch (err: any) {
    console.error("[web-security] docx download error:", err);
    return res.status(500).json({ message: err?.message ?? "Failed to build the .docx report" });
  }
};

export const exportReportPdf = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const { filePath, fileName } = await ensureReportDocx(sessionId, userId);
    const pdf = await convertReportToPdf(filePath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName.replace(/\.docx$/i, ".pdf"))}"`,
    );
    return res.status(200).send(pdf);
  } catch (err: any) {
    console.error("[web-security] pdf export error:", err);
    return res.status(500).json({ message: err?.message ?? "Failed to convert the report to PDF" });
  }
};

// --- WOPI protocol (called by Collabora, authorised by access_token) -------

const wopiFileStat = (sessionId: string) => {
  const filePath = reportDocxPath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return { filePath, size: stat.size, mtime: stat.mtime };
};

export const checkWopiFileInfo = async (req: Request, res: Response) => {
  const auth = resolveWopiToken(String(req.query.access_token ?? ""));
  if (!auth || auth.sessionId !== req.params.fileId) {
    return res.status(401).json({ message: "Invalid WOPI token" });
  }
  const stat = wopiFileStat(auth.sessionId);
  if (!stat) return res.status(404).json({ message: "Report file not found" });

  return res.status(200).json({
    BaseFileName: `${auth.sessionId}.docx`,
    Size: stat.size,
    UserId: auth.uid,
    UserFriendlyName: "ผู้ทดสอบ",
    UserCanWrite: true,
    UserCanNotWriteRelative: true,
    SupportsRename: false,
    SupportsUpdate: true,
    LastModifiedTime: stat.mtime.toISOString(),
  });
};

export const getWopiFile = async (req: Request, res: Response) => {
  const auth = resolveWopiToken(String(req.query.access_token ?? ""));
  if (!auth || auth.sessionId !== req.params.fileId) {
    return res.status(401).json({ message: "Invalid WOPI token" });
  }
  const stat = wopiFileStat(auth.sessionId);
  if (!stat) return res.status(404).json({ message: "Report file not found" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  return res.status(200).send(fs.readFileSync(stat.filePath));
};

export const putWopiFile = async (req: Request, res: Response) => {
  const auth = resolveWopiToken(String(req.query.access_token ?? ""));
  if (!auth || auth.sessionId !== req.params.fileId) {
    return res.status(401).json({ message: "Invalid WOPI token" });
  }
  const body = req.body as Buffer | undefined;
  if (!body || !Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({ message: "Empty document body" });
  }

  const filePath = reportDocxPath(auth.sessionId);
  fs.writeFileSync(filePath, body);
  markReportEditedByWord(auth.sessionId);
  return res.status(200).json({ LastModifiedTime: fs.statSync(filePath).mtime.toISOString() });
};
