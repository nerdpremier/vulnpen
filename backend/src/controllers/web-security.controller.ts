import { Request, Response } from "express";
import SessionsModel, {
  SessionVulnerabilityDoc,
} from "../models/Sessions/Sessions.model";
import type { WebAppTestPlanDoc } from "../models/Sessions/Sessions.model";
import { requireActiveSession } from "../services/session.helpers";
import { mapUnclassifiedVulnerabilities } from "../services/vulnerability.service";
import {
  TEST_PLAN_DEPTHS,
  computeCoverage,
  createTestPlan,
  normalizeTestStatus,
  updateTestCase,
} from "../services/web-security/test-plan.service";
import {
  describeOwaspMapping,
  mapFindingToOwaspTop10,
} from "../services/web-security/owasp-mapping.service";
import { buildWebAppPentestReport } from "../services/web-security/report.service";
import {
  OWASP_TOP10_2025,
  OWASP_TOP10_2025_SOURCE,
  OWASP_TOP10_2025_VERSION,
  WSTG_CATEGORIES,
  WSTG_SOURCE,
  WSTG_TESTS,
  WSTG_VERSION,
  getOwaspCategory,
} from "../knowledge";

function catalogPayload() {
  return {
    version: WSTG_VERSION,
    source: WSTG_SOURCE,
    totalTests: WSTG_TESTS.length,
    categories: WSTG_CATEGORIES.map((category) => ({
      code: category.code,
      section: category.section,
      name: category.name,
      objective: category.objective,
      testCount: WSTG_TESTS.filter((test) => test.category === category.code).length,
    })),
    depths: TEST_PLAN_DEPTHS.map((depth) => ({
      id: depth.id,
      label: depth.label,
      description: depth.description,
      testCount: depth.testCount,
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
    const result = createTestPlan({
      target: typeof body.target === "string" ? body.target : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      depth: body.depth,
      categories: Array.isArray(body.categories) ? body.categories : undefined,
      testIds: Array.isArray(body.testIds)
        ? body.testIds
        : Array.isArray(body.test_ids)
          ? body.test_ids
          : undefined,
      existing,
    });

    await SessionsModel.updateOne(
      { sessionId, uid: userId },
      { $set: { webAppTestPlan: result.plan } },
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

    await SessionsModel.updateOne(
      { sessionId, uid: userId },
      { $set: { webAppTestPlan: updated.plan } },
    );

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

    const report = buildWebAppPentestReport({
      session: {
        sessionId,
        name: refreshed.name ?? "Engagement",
        description: refreshed.description ?? "",
        createdAt: refreshed.createdAt as unknown as Date,
      },
      vulnerabilities: (refreshed.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
      testPlan: (refreshed.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null,
    });

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
    const plan = (refreshed?.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
    const coverage = plan ? computeCoverage(plan.cases) : null;

    return res.status(200).json({
      framework: {
        version: OWASP_TOP10_2025_VERSION,
        source: OWASP_TOP10_2025_SOURCE,
        categories: OWASP_TOP10_2025.map((category) => {
          const owaspRow = coverage?.byOwasp.find((row) => row.key === category.id);
          return {
            id: category.id,
            rank: category.rank,
            title: category.title,
            summary: category.summary,
            cwes: category.cwes,
            wstgFocus: category.wstgFocus,
            findings: vulnerabilities.filter(
              (vulnerability) => vulnerability.owaspTop10 === category.id,
            ).length,
            testsPlanned: owaspRow?.total ?? 0,
            testsExecuted: owaspRow?.executed ?? 0,
            testsFailed: owaspRow?.failed ?? 0,
          };
        }),
      },
      totalFindings: vulnerabilities.length,
      unmappedFindings: vulnerabilities.filter((vulnerability) => !vulnerability.owaspTop10).length,
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