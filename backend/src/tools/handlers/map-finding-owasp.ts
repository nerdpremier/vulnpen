import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import SessionsModel from "../../models/Sessions/Sessions.model";
import type { SessionVulnerabilityDoc } from "../../models/Sessions/Sessions.model";
import {
  describeOwaspMapping,
  mapFindingToOwaspTop10,
  suggestWstgTestsForFinding,
} from "../../services/web-security/owasp-mapping.service";
import { classifyWithLlm } from "../../services/web-security/owasp-llm-classifier";
import {
  getOwaspCategory,
  getWstgTest,
  normalizeOwaspTop10Id,
  OWASP_TOP10_2025,
} from "../../knowledge";

const VALID_CATEGORIES = OWASP_TOP10_2025.map(
  (category) => `${category.id} ${category.title}`,
).join("; ");

const mapFindingOwasp: ToolDefinition = {
  name: "map_finding_owasp",
  description:
    "Classify a finding against the OWASP Top 10:2025 and persist the classification. " +
    "Pass vulnerability_id to classify an existing finding (apply=true to store), or title/cwe/wstg_id for one still being investigated; " +
    "apply_to_all=true maps every unmapped finding in the session. The cascade (your category → WSTG case → CWE → LLM) runs automatically. " +
    `Valid categories: ${VALID_CATEGORIES}.`,
  parameters: {
    type: "object",
    properties: {
      vulnerability_id: {
        type: "string",
        description: "Id of an existing finding in this session to classify.",
      },
      title: { type: "string", description: "Finding title when it is not yet recorded." },
      description: {
        type: "string",
        description: "Short description of the finding, including the mechanism.",
      },
      evidence: { type: "string", description: "Evidence text, used to corroborate the mapping." },
      cwe: { type: "string", description: "CWE id of the underlying weakness, e.g. CWE-89." },
      wstg_id: {
        type: "string",
        description:
          "WSTG test case that produced the finding, e.g. WSTG-INPV-05 — the strongest mapping signal.",
      },
      owasp_top10: {
        type: "string",
        description:
          "Explicit category (A01:2025 ... A10:2025); supply only when the classification is clear from the evidence.",
      },
      apply: {
        type: "boolean",
        description: "Persist the classification on the finding (with vulnerability_id). Default false.",
      },
      apply_to_all: {
        type: "boolean",
        description: "Map and persist every finding in this session that has no OWASP category yet.",
      },
    },
    required: [],
  },
  timeoutMs: 30_000,
  async execute(args: Record<string, any>, ctx: ExecutionContext): Promise<ToolResult> {
    const sessionId = ctx.sessionId;
    if (!sessionId) return { output: "No session in context.", exitCode: 1 };

    try {
      if (args.apply_to_all === true) {
        const session = await SessionsModel.findOne({ sessionId })
          .select("vulnerabilities")
          .lean();
        const vulnerabilities = (session?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
        const unmapped = vulnerabilities.filter(
          (vulnerability) => !normalizeOwaspTop10Id(vulnerability.owaspTop10),
        );
        if (!unmapped.length) {
          return {
            output: `${vulnerabilities.length} finding(s) in this session; all of them already carry an OWASP Top 10:2025 category.`,
            exitCode: 0,
          };
        }

        const lines: string[] = [];
        for (const vulnerability of unmapped) {
          let result = mapFindingToOwaspTop10({
            title: vulnerability.title,
            description: vulnerability.description,
            contextSummary: vulnerability.contextSummary,
            evidence: vulnerability.evidence,
            endpoint: vulnerability.endpoint,
            service: vulnerability.service,
            cwe: vulnerability.cwe,
            wstgId: vulnerability.wstgId,
          });
          if (!result.primary) {
            const llmResult = await classifyWithLlm(
              {
                title: vulnerability.title,
                description: vulnerability.description,
                contextSummary: vulnerability.contextSummary,
                evidence: vulnerability.evidence,
                endpoint: vulnerability.endpoint,
                cwe: vulnerability.cwe,
                wstgId: vulnerability.wstgId,
              },
              { userId: ctx.userId, sessionId, candidates: result.ambiguous },
            );
            if (llmResult) result = llmResult;
          }
          if (!result.primary) {
            lines.push(`- ${vulnerability.title}: still unmapped — ${result.rationale}`);
            continue;
          }
          await persistMapping(sessionId, vulnerability.vulnerabilityId, result);
          lines.push(
            `- ${vulnerability.title}: ${result.primary} ${result.primaryTitle ?? ""} (${result.confidence} confidence via ${result.source}, ${vulnerability.service ?? vulnerability.endpoint ?? vulnerability.host})`,
          );
        }
        return {
          output: [`Mapped ${unmapped.length} finding(s):`, ...lines].join("\n"),
          exitCode: 0,
        };
      }

      let target: SessionVulnerabilityDoc | undefined;
      if (typeof args.vulnerability_id === "string" && args.vulnerability_id.trim()) {
        const session = await SessionsModel.findOne({ sessionId })
          .select("vulnerabilities")
          .lean();
        target = ((session?.vulnerabilities ?? []) as SessionVulnerabilityDoc[]).find(
          (vulnerability) => vulnerability.vulnerabilityId === args.vulnerability_id.trim(),
        );
        if (!target) {
          return { output: `No finding with id ${args.vulnerability_id} in this session.`, exitCode: 1 };
        }
      }

      let result = mapFindingToOwaspTop10({
        title: args.title ?? target?.title,
        description: args.description ?? target?.description,
        contextSummary: target?.contextSummary,
        evidence: args.evidence ?? target?.evidence,
        endpoint: target?.endpoint,
        service: target?.service,
        cwe: args.cwe ?? target?.cwe,
        wstgId: args.wstg_id ?? target?.wstgId,
        owaspTop10: args.owasp_top10 ?? target?.owaspTop10,
      });
      if (!result.primary) {
        const llmResult = await classifyWithLlm(
          {
            title: args.title ?? target?.title,
            description: args.description ?? target?.description,
            contextSummary: target?.contextSummary,
            evidence: args.evidence ?? target?.evidence,
            endpoint: target?.endpoint,
            cwe: args.cwe ?? target?.cwe,
            wstgId: args.wstg_id ?? target?.wstgId,
          },
          { userId: ctx.userId, sessionId, candidates: result.ambiguous },
        );
        if (llmResult) result = llmResult;
      }

      const lines: string[] = [describeOwaspMapping(result)];
      const wstg = getWstgTest(args.wstg_id ?? target?.wstgId);
      if (wstg) {
        lines.push(`WSTG reference: ${wstg.id} (${wstg.section}) ${wstg.title} — ${wstg.objective}`);
      }
      if (result.primary) {
        const category = getOwaspCategory(result.primary);
        if (category) {
          lines.push(
            `Category guidance (${category.id} ${category.title}): ${category.summary}`,
            `Typical remediation: ${category.remediation.slice(0, 3).join(" ")}`,
          );
        }
      } else {
        const suggestions = suggestWstgTestsForFinding({
          title: args.title ?? target?.title,
          description: args.description ?? target?.description,
          evidence: args.evidence ?? target?.evidence,
          cwe: args.cwe ?? target?.cwe,
        });
        if (suggestions.length) {
          lines.push(`Candidate WSTG tests to trace this finding to: ${suggestions.join(", ")}`);
        }
      }

      if (args.apply === true && target) {
        await persistMapping(sessionId, target.vulnerabilityId, result, args.wstg_id ?? target.wstgId);
        lines.push(`Stored on finding ${target.vulnerabilityId}.`);
      } else if (target) {
        lines.push(
          `Not stored yet — call again with apply=true (vulnerability_id ${target.vulnerabilityId}) to persist the classification.`,
        );
      }

      return { output: lines.join("\n"), exitCode: 0 };
    } catch (err: any) {
      return { output: `map_finding_owasp failed: ${err?.message ?? err}`, exitCode: 1 };
    }
  },
};

interface MappingLike {
  primary?: string;
  primaryTitle?: string;
  related: string[];
  confidence: string;
  source: string;
  rationale: string;
}

async function persistMapping(
  sessionId: string,
  vulnerabilityId: string,
  result: MappingLike,
  wstgId?: string,
): Promise<void> {
  const update: Record<string, any> = {
    "vulnerabilities.$.owaspTop10": result.primary,
    "vulnerabilities.$.owaspTop10Title": result.primaryTitle,
    "vulnerabilities.$.owaspRelated": result.related,
    "vulnerabilities.$.owaspConfidence": result.confidence,
    "vulnerabilities.$.owaspRationale": result.rationale,
    "vulnerabilities.$.owaspMappedAt": new Date(),
    "vulnerabilities.$.updatedAt": new Date(),
  };
  const wstg = getWstgTest(wstgId);
  if (wstg) {
    update["vulnerabilities.$.wstgId"] = wstg.id;
    update["vulnerabilities.$.wstgTitle"] = wstg.title;
    update["vulnerabilities.$.wstgCategory"] = wstg.category;
  }
  await SessionsModel.updateOne(
    { sessionId, "vulnerabilities.vulnerabilityId": vulnerabilityId },
    { $set: update },
  );
}

export default mapFindingOwasp;