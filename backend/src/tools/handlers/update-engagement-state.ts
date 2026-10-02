import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import { EngagementState } from "../../services/engagement-state";
import SessionsModel from "../../models/Sessions/Sessions.model";
import type {
  SessionVulnerabilityDoc,
  WebAppTestPlanDoc,
} from "../../models/Sessions/Sessions.model";
import {
  normalizeVulnerability,
  upsertSessionVulnerability,
} from "../../services/vulnerability.service";
import { classifyWithLlm } from "../../services/web-security/owasp-llm-classifier";

function str(v: any): string {
  return typeof v === "string" ? v.trim() : "";
}

const updateEngagementState: ToolDefinition = {
  name: "update_engagement_state",
  description:
    "Record a structured finding to the persistent engagement state. This state is always visible in the system prompt and survives context summarization. Call after every significant discovery.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "add_host",
          "add_service",
          "add_credential",
          "add_vulnerability",
          "remove_finding",
          "add_shell",
          "add_key_discovery",
          "add_file",
          "log_approach",
          "set_next_steps",
        ],
        description: "The type of state update to make.",
      },
      data: {
        type: "object",
        description:
          "The action-specific state data. For add_vulnerability include title, host/target, service or endpoint, " +
          "likelihood and impactRating (risk matrix factors the severity is computed from), evidence, stepsToReproduce, contextSummary, impact, remediation, and exploited status when known. " +
          "Never declare a severity word directly: rate the likelihood and impact factors honestly and the system derives the severity from the risk matrix. " +
          "CWE and owaspTop10 are optional: set wstgId to the WSTG v4.2 test case that produced the finding (e.g. WSTG-INPV-05) and set " +
          "owaspTop10/CWE only when you know they fit. A finding with no well-fitting category or CWE is accepted unmapped — never invent a mapping for completeness. " +
          "For add_key_discovery provide title and/or description (discovery/value are accepted for compatibility). " +
          'For remove_finding provide vulnerability_id of a finding that turned out not to be real (e.g. a placeholder or false positive); ' +
          "it is deleted from the session and unlinked from any test case that references it. " +
          "This is a proof-of-concept engagement: when the finding is a destructive capability you proved without carrying it out " +
          "(for example a delete endpoint a low-privilege user can reach), record it with exploited set to false and state in the impact that the destructive step was deliberately not performed.",
        properties: {
          // Shared fields. Keeping these explicit prevents models from
          // guessing the shape of add_key_discovery calls while retaining the
          // existing permissive schema for the other state actions.
          title: { type: "string" },
          discovery: { type: "string" },
          value: { type: "string" },
          description: { type: "string" },
          host: { type: "string" },
          target: { type: "string" },
          service: { type: "string" },
          endpoint: { type: "string" },
          cwe: { type: "string" },
          cve: { type: "string" },
          evidence: { type: "string" },
          stepsToReproduce: { type: "array", items: { type: "string" } },
          contextSummary: { type: "string" },
          impact: { type: "string" },
          remediation: { type: "string" },
          exploited: {
            type: "boolean",
            description:
              "true only when the action was actually carried out under explicit operator authorisation. A vulnerability proven non-destructively stays false.",
          },
          vulnerability_id: {
            type: "string",
            description: "Finding id to delete, for action remove_finding (vulnerabilityId or exact title).",
          },
          wstgId: {
            type: "string",
            description:
              "WSTG v4.2 test case that produced this finding, e.g. WSTG-INPV-05. The OWASP Top 10:2025 mapping is derived from it.",
          },
          owaspTop10: {
            type: "string",
            description:
              "Explicit OWASP Top 10:2025 category (A01:2025 ... A10:2025). Omit it to classify from the WSTG test case, CWE and finding text.",
          },
          likelihood: {
            type: "number",
            enum: [1, 2, 3],
            description:
              "Risk matrix likelihood factor: 1 = low, 2 = medium, 3 = high. How likely this finding is to be exercised by the threat agents that apply here.",
          },
          impactRating: {
            type: "number",
            enum: [1, 2, 3],
            description:
              "Risk matrix impact factor: 1 = low, 2 = medium, 3 = high. Worst realistic damage to the business if exercised.",
          },
        },
        additionalProperties: true,
      },
    },
    required: ["action", "data"],
  },
  requiresConsent: false,
  timeoutMs: 30_000,

  async execute(
    args: Record<string, any>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const state = ctx.engagementState as EngagementState | undefined;
    if (!state) {
      return { output: "Engagement state not initialized.", exitCode: 1 };
    }

    const { action } = args;
    const data = args.data && typeof args.data === "object" ? args.data : {};

    switch (action) {
      case "add_host": {
        const ip = str(data.ip) || "unknown";
        state.hosts.push({
          ip,
          hostname: data.hostname,
          os: data.os,
          status: data.status ?? "up",
        });
        return { output: `Host ${ip} added.`, exitCode: 0 };
      }

      case "add_service": {
        const host = str(data.host) || "unknown";
        const port = data.port ?? 0;
        const service = str(data.service) || "unknown";
        state.services.push({
          host,
          port,
          protocol: data.protocol ?? "tcp",
          service,
          version: data.version,
          notes: data.notes,
        });
        return {
          output: `Service ${host}:${port} (${service}) added.`,
          exitCode: 0,
        };
      }

      case "add_credential": {
        const username = str(data.username) || "(unknown)";
        state.credentials.push({
          username,
          secret: data.secret ?? "",
          secretType: data.secretType ?? "password",
          source: data.source ?? "unknown",
          validOn: data.validOn ?? [],
        });
        return {
          output: `Credential ${username} added.`,
          exitCode: 0,
        };
      }

      case "add_vulnerability": {
        if (!str(data.title)) {
          return { output: "add_vulnerability requires data.title", exitCode: 1 };
        }
        if (!ctx.sessionId) {
          return { output: "add_vulnerability requires an active session", exitCode: 1 };
        }
        const normalized = normalizeVulnerability(data, {
          source: `agent:${ctx.agentId ?? "main"}`,
        });
        if (!normalized.owaspTop10) {
          // Deterministic layers could not decide (no explicit/WSTG/single-CWE
          // signal) — ask the LLM classifier before the finding is stored.
          const llmMapping = await classifyWithLlm(
            {
              title: normalized.title,
              description: normalized.description,
              contextSummary: normalized.contextSummary,
              evidence: normalized.evidence,
              endpoint: normalized.endpoint,
              cwe: normalized.cwe,
              wstgId: normalized.wstgId,
            },
            { userId: ctx.userId, sessionId: ctx.sessionId },
          );
          if (llmMapping?.primary) {
            normalized.owaspTop10 = llmMapping.primary;
            normalized.owaspTop10Title = llmMapping.primaryTitle;
            normalized.owaspRelated = llmMapping.related;
            normalized.owaspConfidence = llmMapping.confidence;
            normalized.owaspProvenance = llmMapping.provenance ?? "model";
            normalized.owaspRationale = llmMapping.rationale;
            normalized.owaspMappedAt = new Date();
          }
        }
        const persisted = await upsertSessionVulnerability(ctx.sessionId, normalized);
        const existingIndex = state.vulnerabilities.findIndex(
          (v) => v.vulnerabilityId === persisted.vulnerability.vulnerabilityId ||
            v.fingerprint === persisted.vulnerability.fingerprint,
        );
        if (existingIndex >= 0) state.vulnerabilities[existingIndex] = persisted.vulnerability;
        else state.vulnerabilities.push(persisted.vulnerability);
        return {
          output:
            `Vulnerability "${persisted.vulnerability.title}" [${persisted.vulnerability.severity}] ` +
            `${persisted.created ? "added" : "updated"}.\n` +
            `vulnerability_id: ${persisted.vulnerability.vulnerabilityId}`,
          exitCode: 0,
        };
      }

      case "remove_finding": {
        if (!ctx.sessionId) {
          return { output: "remove_finding requires an active session", exitCode: 1 };
        }
        const wanted = str(data.vulnerability_id) || str(data.vulnerabilityId) || str(data.id);
        if (!wanted) {
          return {
            output: 'remove_finding requires data.vulnerability_id (the id add_vulnerability returned).',
            exitCode: 1,
          };
        }
        const session = await SessionsModel.findOne({ sessionId: ctx.sessionId })
          .select("vulnerabilities webAppTestPlan");
        if (!session) return { output: "Session not found.", exitCode: 1 };

        const vulns = (session.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
        const upper = wanted.toUpperCase();
        const target = vulns.find(
          (v) =>
            v.vulnerabilityId === wanted ||
            v.vulnerabilityId?.toUpperCase() === upper ||
            v.title === wanted,
        );
        if (!target) {
          const known = vulns.map((v) => `${v.vulnerabilityId} ${v.title}`).join("; ");
          return {
            output: `No finding matches "${wanted}". Known findings: ${known || "(none)"}.`,
            exitCode: 1,
          };
        }

        await SessionsModel.updateOne(
          { sessionId: ctx.sessionId },
          { $pull: { vulnerabilities: { vulnerabilityId: target.vulnerabilityId } } },
        );

        const plan = session.webAppTestPlan as WebAppTestPlanDoc | undefined;
        if (plan?.cases?.length) {
          let unlinked = 0;
          for (const testCase of plan.cases) {
            if (testCase.linkedVulnerabilityIds?.includes(target.vulnerabilityId)) {
              testCase.linkedVulnerabilityIds = testCase.linkedVulnerabilityIds.filter(
                (id) => id !== target.vulnerabilityId,
              );
              unlinked += 1;
            }
          }
          if (unlinked) {
            await SessionsModel.updateOne(
              { sessionId: ctx.sessionId },
              { $set: { webAppTestPlan: plan } },
            );
          }
        }

        state.vulnerabilities = state.vulnerabilities.filter(
          (v) => v.vulnerabilityId !== target.vulnerabilityId,
        );
        return {
          output:
            `Removed finding ${target.vulnerabilityId} "${target.title}". ` +
            "If its test case still applies, re-run it rather than re-adding a placeholder.",
          exitCode: 0,
        };
      }

      case "add_shell": {
        const shellHost = str(data.host) || "unknown";
        const shellUser = str(data.user) || "unknown";
        state.shells.push({
          shellId: data.shellId ?? "unknown",
          host: shellHost,
          user: shellUser,
          privilegeLevel: data.privilegeLevel ?? "user",
          type: data.type ?? "ssh",
          obtainedVia: data.obtainedVia,
        });
        return {
          output: `Shell on ${shellHost} as ${shellUser} recorded.`,
          exitCode: 0,
        };
      }

      case "add_key_discovery": {
        // Agents historically used `discovery`/`value`, while newer
        // prompts naturally produce a titled record. Normalize all supported
        // forms into the string-based in-memory state, but never record an
        // empty placeholder: an empty discovery is indistinguishable from a
        // successful update in the prompt and causes the next turn to lose
        // the actual finding.
        const title = str(data.title);
        const description = str(data.description);
        const legacyValue = str(data.discovery) || str(data.value);
        const discovery =
          legacyValue ||
          [title, description].filter(Boolean).join(": ");
        if (!discovery) {
          return {
            output:
              "add_key_discovery requires data.title or data.description " +
              "(data.discovery/data.value are also accepted).",
            exitCode: 1,
          };
        }
        state.keyDiscoveries.push(discovery);
        return {
          output: `Key discovery recorded: ${discovery}`,
          exitCode: 0,
        };
      }

      case "add_file": {
        const filePath = str(data.path) || "unknown";
        state.files.push({
          path: filePath,
          description: data.description ?? "",
        });
        return {
          output: `File ${filePath} recorded.`,
          exitCode: 0,
        };
      }

      case "log_approach":
        if (!str(data.technique)) {
          return { output: "log_approach requires data.technique", exitCode: 1 };
        }
        state.approachesTried.push({
          technique: data.technique ?? "",
          target: data.target ?? "",
          result: data.result ?? "failed",
          detail: data.detail ?? "",
        });
        return {
          output: `Approach logged: ${data.technique} → ${data.result ?? "failed"}`,
          exitCode: 0,
        };

      case "set_next_steps": {
        const steps = data.steps ?? data.nextSteps;
        state.nextSteps = Array.isArray(steps) ? steps : [steps];
        return {
          output: `Next steps updated (${state.nextSteps.length} items).`,
          exitCode: 0,
        };
      }

      default:
        return { output: `Unknown action: ${action}`, exitCode: 1 };
    }
  },
};

export default updateEngagementState;
