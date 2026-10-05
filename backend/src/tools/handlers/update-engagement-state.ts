import { ToolDefinition, ToolResult, ExecutionContext } from "../types";
import { EngagementState } from "../../services/engagement-state";
import {
  recordSessionFinding,
  removeSessionFinding,
  FindingOutcome,
} from "../../services/vulnerability.service";

function str(v: any): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Map a finding-store outcome onto the tool result the model receives. */
function findingOutcome({ ok, output }: FindingOutcome): ToolResult {
  return { output, exitCode: ok ? 0 : 1 };
}

const updateEngagementState: ToolDefinition = {
  name: "update_engagement_state",
  description:
    "Record a structured finding to the persistent engagement state (always visible in the system prompt, survives summarization). Call after every significant discovery.",
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
          "Action-specific data. add_vulnerability: title, host/target, endpoint, likelihood + impactRating " +
          "(1-3 — the system derives severity), evidence, stepsToReproduce, " +
          "impact, remediation, exploited; wstgId = producing test case; omit owaspTop10/CWE unless " +
          "confident. A destructive capability proved without carrying it out is exploited=false, stated " +
          "in impact. add_key_discovery: title and/or description. remove_finding: vulnerability_id.",
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
            description: "true only when actually carried out under operator authorisation.",
          },
          vulnerability_id: {
            type: "string",
            description: "Finding id to delete (remove_finding).",
          },
          wstgId: {
            type: "string",
            description:
              "WSTG case that produced this finding (e.g. WSTG-INPV-05); must exist in the plan — auto-linked as failed.",
          },
          owaspTop10: {
            type: "string",
            description: "Category (A01:2025 ... A10:2025); omit to classify automatically.",
          },
          screenshots: {
            type: "array",
            items: { type: "string" },
            description:
              "Screenshot filenames exactly as browser_action reported them — attach only when the page itself is the evidence.",
          },
          likelihood: {
            type: "number",
            enum: [1, 2, 3],
            description: "1 = low, 2 = medium, 3 = high.",
          },
          impactRating: {
            type: "number",
            enum: [1, 2, 3],
            description: "1 = low, 2 = medium, 3 = high (worst realistic business damage).",
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

    const result = await applyUpdate(args, ctx, state);
    // One flush per successful call: the state module owns persistence, the
    // handler only decides when a call has actually changed the record.
    if (result.exitCode === 0) {
      await state.flush();
    }
    return result;
  },
};

async function applyUpdate(
  args: Record<string, any>,
  ctx: ExecutionContext,
  state: EngagementState,
): Promise<ToolResult> {
  const { action } = args;
  const data = args.data && typeof args.data === "object" ? args.data : {};

  switch (action) {
    case "add_host": {
      const ip = str(data.ip) || "unknown";
      state.addHost({
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
      state.addService({
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
      state.addCredential({
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
      if (!ctx.sessionId) {
        return { output: "add_vulnerability requires an active session", exitCode: 1 };
      }
      // The whole record chain (plan-case resolution, normalization, screenshot
      // filtering, OWASP classification, upsert, case linking) and its refusal
      // texts live behind recordSessionFinding — the finding lifecycle has one
      // owner and this switch only dispatches.
      return findingOutcome(
        await recordSessionFinding(
          {
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            agentId: ctx.agentId,
            state,
          },
          data,
        ),
      );
    }

    case "remove_finding": {
      if (!ctx.sessionId) {
        return { output: "remove_finding requires an active session", exitCode: 1 };
      }
      const wanted = str(data.vulnerability_id) || str(data.vulnerabilityId) || str(data.id);
      return findingOutcome(await removeSessionFinding({ sessionId: ctx.sessionId, state }, wanted));
    }

    case "add_shell": {
      const shellHost = str(data.host) || "unknown";
      const shellUser = str(data.user) || "unknown";
      state.addShell({
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
      // forms into the string-based state, but never record an
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
      state.addKeyDiscovery(discovery);
      return {
        output: `Key discovery recorded: ${discovery}`,
        exitCode: 0,
      };
    }

    case "add_file": {
      const filePath = str(data.path) || "unknown";
      state.addFile({
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
      state.logApproach({
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
      state.setNextSteps(Array.isArray(steps) ? steps : [steps]);
      return {
        output: `Next steps updated (${state.nextSteps.length} items).`,
        exitCode: 0,
      };
    }

    default:
      return { output: `Unknown action: ${action}`, exitCode: 1 };
  }
}

export default updateEngagementState;
