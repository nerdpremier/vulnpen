import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import SessionsModel from "../../models/Sessions/Sessions.model";
import type { SessionVulnerabilityDoc } from "../../models/Sessions/Sessions.model";
import {
  describeOwaspMapping,
  mapFindingToOwaspTop10,
} from "../../services/web-security/owasp-mapping.service";
import { applyOwaspMapping } from "../../services/vulnerability.service";
import {
  getOwaspCategory,
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
    "The classification is a lookup of the finding's CWE in the CWE lists OWASP publishes for the ten 2025 categories — " +
    "it is deterministic, so pass the CWE and the category follows; you do not choose the category. " +
    "Pass vulnerability_id to classify a recorded finding (apply=true to store it), or cwe for one still being investigated; " +
    "apply_to_all=true re-derives every finding in this session from its CWE and writes back what changed. " +
    "A finding with no CWE, or a CWE no 2025 list contains, comes back unmapped — that is the correct answer, not a failure. " +
    `Categories: ${VALID_CATEGORIES}.`,
  parameters: {
    type: "object",
    properties: {
      vulnerability_id: {
        type: "string",
        description: "Id of an existing finding in this session to classify.",
      },
      cwe: {
        type: "string",
        description:
          "CWE id of the weakness, e.g. CWE-89. The only input the classification uses.",
      },
      title: {
        type: "string",
        description: "Finding title, when classifying one that is not recorded yet.",
      },
      apply: {
        type: "boolean",
        description: "Persist the classification on the finding (with vulnerability_id). Default false.",
      },
      apply_to_all: {
        type: "boolean",
        description: "Classify and persist every finding in this session that has no OWASP category yet.",
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
        // The stored category is a cache of the derivation, so reconcile rather
        // than only fill gaps: a stale category is corrected, and one that no
        // longer follows from a CWE is cleared.
        const stale = vulnerabilities.filter(
          (vulnerability) =>
            mapFindingToOwaspTop10({ cwe: vulnerability.cwe }).primary !==
            normalizeOwaspTop10Id(vulnerability.owaspTop10),
        );
        if (!stale.length) {
          return {
            output: `${vulnerabilities.length} finding(s) in this session; every one already matches its CWE.`,
            exitCode: 0,
          };
        }

        const lines: string[] = [];
        for (const vulnerability of stale) {
          const result = mapFindingToOwaspTop10({ cwe: vulnerability.cwe });
          await applyOwaspMapping(sessionId, vulnerability.vulnerabilityId, result);
          lines.push(
            result.primary
              ? `- ${vulnerability.title}: ${result.primary} ${result.primaryTitle ?? ""} (official, via ${vulnerability.cwe})`
              : `- ${vulnerability.title}: unmapped — ${result.rationale}`,
          );
        }
        return {
          output: [
            `Re-derived ${stale.length} of ${vulnerabilities.length} finding(s) from their CWE:`,
            ...lines,
          ].join("\n"),
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

      const cwe = args.cwe ?? target?.cwe;
      const result = mapFindingToOwaspTop10({ cwe });

      const lines: string[] = [describeOwaspMapping(result)];
      if (result.primary) {
        const category = getOwaspCategory(result.primary);
        if (category) {
          lines.push(
            `Category guidance (${category.id} ${category.title}): ${category.summary}`,
            `Typical remediation: ${category.remediation.slice(0, 3).join(" ")}`,
          );
        }
      } else {
        lines.push(
          "Record the weakness id on the finding (data.cwe) and it will classify itself; " +
            "do not pick a category by hand — this system reports only what the OWASP lists support.",
        );
      }

      if (args.apply === true && target && result.primary) {
        await applyOwaspMapping(sessionId, target.vulnerabilityId, result);
        lines.push(`Stored on finding ${target.vulnerabilityId}.`);
      } else if (target && result.primary) {
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

export default mapFindingOwasp;
