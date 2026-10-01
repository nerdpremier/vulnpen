import { Request, Response } from "express";
import SessionsModel, {
  SessionVulnerabilityDoc,
} from "../models/Sessions/Sessions.model";
import type { WebAppTestPlanDoc } from "../models/Sessions/Sessions.model";
import { requireActiveSession } from "../services/session.helpers";
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
import {
  OWASP_TOP10_2025,
  OWASP_TOP10_2025_SOURCE,
  OWASP_TOP10_2025_VERSION,
  WSTG_CATEGORIES,
  WSTG_SOURCE,
  WSTG_TESTS,
  WSTG_VERSION,
  getOwaspCategory,
  normalizeOwaspTop10Id,
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

/**
 * Persist the plan and fail loudly when Mongo does not store it: a write that silently does
 * nothing looks like success in the UI, which is worse than an error.
 */
async function persistTestPlan(sessionId: string, uid: unknown, plan: WebAppTestPlanDoc) {
  const result = await SessionsModel.updateOne(
    { sessionId, uid },
    { $set: { webAppTestPlan: plan } },
  );
  if (!result.modifiedCount) {
    throw new Error(
      result.matchedCount
        ? "MongoDB stored no change for the WSTG test plan"
        : "Session not found while saving the WSTG test plan",
    );
  }
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

      await persistTestPlan(sessionId, userId, result.plan);

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
      notes: typeof body.notes === "string" ? body.notes : undefined,
      categories: Array.isArray(body.categories) ? body.categories : undefined,
      testIds: Array.isArray(body.testIds)
        ? body.testIds
        : Array.isArray(body.test_ids)
          ? body.test_ids
          : undefined,
      existing,
    });

    await persistTestPlan(sessionId, userId, result.plan);

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

    await persistTestPlan(sessionId, userId, updated.plan);

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

    await persistTestPlan(sessionId, userId, removed.plan);

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

    await persistTestPlan(sessionId, userId, removed.plan);

    return res.status(200).json({
      ...planPayload(removed.plan),
      removed: removed.removed,
    });
  } catch (err: any) {
    console.error("[web-security] test case bulk remove error:", err);
    return res.status(500).json({ message: "Failed to remove the test cases" });
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
          findings: vulnerabilities.filter(
            // Findings may store the category in variant forms ("a05", "A05:2025");
            // normalize before comparing, same as the prompt/report paths.
            (vulnerability) =>
              vulnerability.owaspTop10 &&
              normalizeOwaspTop10Id(vulnerability.owaspTop10) === category.id,
          ).length,
        })),
      },
      totalFindings: vulnerabilities.length,
      unmappedFindings: vulnerabilities.filter(
        (vulnerability) => !normalizeOwaspTop10Id(vulnerability.owaspTop10),
      ).length,
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