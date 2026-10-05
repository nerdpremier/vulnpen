import SessionsModel, {
  SessionDoc,
  SessionVulnerabilityDoc,
  WebAppTestPlanDoc,
} from "../models/Sessions/Sessions.model";
import type { SSEWriter } from "../utils/sse";
import { createSlashReply, SlashReply } from "./slash-reply";
import { invoke_llm } from "../utils/llm/invoke";
import { invoke_llm_streaming } from "../utils/llm/streaming";
import { sessionLifecycle } from "./session.lifecycle";
import { resetSessionContext } from "./session.helpers";
import { resetAgentRun } from "./session-transcript";
import { getOwaspCategory } from "../knowledge";
import {
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
} from "./web-security/test-plan.service";
import {
  loadSessionPlan,
  saveSessionPlan,
} from "./web-security/session-plan-store";
import { buildWebAppPentestReport, serializeFindingsForReport } from "./web-security/report.service";
import { mapUnclassifiedVulnerabilities } from "./vulnerability.service";
import { boundedConversationText } from "./context.service";

export interface SlashCommandDef {
  name: string;
  description: string;
  usage: string;
  args?: { name: string; required: boolean; description: string }[];
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: "summarize",
    description: "Summarize the entire session so far",
    usage: "/summarize",
  },
  {
    name: "status",
    description: "Show current engagement status — targets, ports, vulns, credentials",
    usage: "/status",
  },
  {
    name: "clear",
    description: "Clear the conversation context (keeps system prompt)",
    usage: "/clear",
  },
  {
    name: "help",
    description: "List all available slash commands",
    usage: "/help",
  },
  {
    name: "targets",
    description: "Extract and list all targets/IPs mentioned in the session",
    usage: "/targets",
  },
  {
    name: "export",
    description: "Export session findings as a structured report",
    usage: "/export",
  },
  {
    name: "shells",
    description: "List all active and closed shell sessions",
    usage: "/shells",
  },
  {
    name: "reset",
    description: "Reset agent state to idle (useful if agent is stuck)",
    usage: "/reset",
  },
  {
    name: "wstg",
    description:
      "Create, refresh or show the OWASP WSTG v4.2 test plan for this session",
    usage: "/wstg [target]",
  },
  {
    name: "map",
    description: "Map every finding to the OWASP Top 10:2025 and show the mapping",
    usage: "/map",
  },
  {
    name: "report",
    description: "Generate the draft Web Application Penetration Testing Report",
    usage: "/report",
  },
];

export function parseSlashCommand(input: string): { command: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: "" };
  }
  return {
    command: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export function matchCommands(partial: string): SlashCommandDef[] {
  const lower = partial.toLowerCase().replace(/^\//, "");
  if (!lower) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(lower));
}

export async function executeSlashCommand(params: {
  sessionId: string;
  userId: string;
  command: string;
  args: string;
  sse: SSEWriter;
}): Promise<void> {
  const { sessionId, userId, command, args, sse } = params;

  const handler = commandHandlers[command];
  const reply = createSlashReply(sse, command);
  if (!handler) {
    reply.fail(`Unknown command \`/${command}\`. Type \`/help\` to see available commands.`);
    return;
  }

  try {
    await handler({
      sessionId,
      userId,
      args,
      reply,
      loadSession: async () => {
        const session = await SessionsModel.findOne({ sessionId });
        if (!session) {
          reply.sessionMissing();
          return null;
        }
        return session;
      },
    });
  } catch (err: any) {
    console.error(`[slash-command] /${command} error:`, err);
    reply.fail(`Error executing \`/${command}\`: ${err.message ?? "Unknown error"}`);
  }
}

type CommandHandler = (ctx: {
  sessionId: string;
  userId: string;
  args: string;
  reply: SlashReply;
  /**
   * The session lookup the transcript-reading handlers share: replies
   * sessionMissing and returns null when the session does not exist, so the
   * handler only early-returns. Handlers with narrow projections (/map,
   * /report) keep their own select() — but the same missing-session guard.
   */
  loadSession: () => Promise<SessionDoc | null>;
}) => Promise<void>;

const commandHandlers: Record<string, CommandHandler> = {
  help: async ({ reply }) => {
    const lines = SLASH_COMMANDS.map(
      (cmd) => `**\`/${cmd.name}\`** — ${cmd.description}`,
    );
    reply.ok(`### Available Commands\n\n${lines.join("\n\n")}`);
  },

  clear: async ({ sessionId, reply, loadSession }) => {
    if (!(await loadSession())) return;

    await resetSessionContext(sessionId);

    reply.ok("Context cleared. Session history has been reset.", {
      action: "clear_messages",
    });
  },

  reset: async ({ sessionId, reply }) => {
    await resetAgentRun(sessionId);

    reply.ok("Agent state has been reset to idle.", {
      action: "reset_state",
    });
  },

  summarize: async ({ sessionId, userId, reply, loadSession }) => {
    const session = await loadSession();
    if (!session) return;

    const nonSystemMessages = session.messages.filter(
      (m: any) => m.role !== "system",
    );

    if (nonSystemMessages.length === 0) {
      reply.ok("Nothing to summarize — the session is empty.");
      return;
    }

    const conversationText = await boundedConversationText(nonSystemMessages);

    const stream = reply.stream("Generating summary...");

    let accumulated = "";

    const result = await invoke_llm_streaming({
      messages: [
        {
          role: "system",
          content: `You are a concise penetration test engagement summarizer. Summarize the engagement so far in a clear, structured format. Include: targets, discovered services/ports, tools used, vulnerabilities found, credentials obtained, current status, and recommended next steps. Use markdown formatting.`,
        },
        { role: "user", content: conversationText },
      ],
      temperature: 0.3,
      sessionId,
      userId,
      tags: [
        "slash-command",
        "summarize",
        `session_id:${sessionId}`,
        `workspace_id:${session.workspaceId ?? "unknown"}`,
        "agent_role:slash_command",
      ],
      generationName: "slash-summarize",
      onDelta(delta) {
        if (delta.type === "text" && delta.content) {
          accumulated += delta.content;
          stream.emit(delta.content);
        }
      },
    });

    stream.complete(
      accumulated || result.content || "Failed to generate summary.",
    );
  },

  status: async ({ sessionId, reply, loadSession }) => {
    const session = await loadSession();
    if (!session) return;

    const lines: string[] = [];

    lines.push(`### Session Status`);
    lines.push(``);
    lines.push(`- **Session ID:** \`${sessionId}\``);
    lines.push(`- **Agent State:** ${session.agentState}`);
    lines.push(`- **Messages:** ${session.messages.length}`);
    lines.push(`- **Turn Index:** ${session.turnIndex}`);
    lines.push(`- **Total Tokens Used:** ${session.totalTokens?.toLocaleString() ?? 0}`);

    reply.ok(lines.join("\n"));
  },

  targets: async ({ sessionId, reply, loadSession }) => {
    const session = await loadSession();
    if (!session) return;

    const allContent = session.messages
      .map((m: any) => m.content ?? "")
      .join("\n");

    const ipv4Pattern = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/g;
    const hostnamePattern = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;

    const ips = [...new Set(allContent.match(ipv4Pattern) ?? [])];
    const hostnames = [
      ...new Set(
        (allContent.match(hostnamePattern) ?? []).map((h) =>
          h.replace(/\.+$/, "").toLowerCase(),
        ),
      ),
    ].filter(
      (h) =>
        // Skip prose artifacts ("e.g."), sentence-ending capture that shrank
        // to a single-letter label, and anything that is really a file name.
        h.length > 3 &&
        !/^[a-z]\.[a-z]$/.test(h) &&
        !h.match(/\.(js|ts|py|txt|json|xml|html|css|scss|md|log|csv|pdf|png|jpg)$/i),
    );

    const lines: string[] = ["### Discovered Targets", ""];

    if (ips.length > 0) {
      lines.push("#### IP Addresses");
      for (const ip of ips) lines.push(`- \`${ip}\``);
      lines.push("");
    }

    if (hostnames.length > 0) {
      lines.push("#### Hostnames");
      for (const h of hostnames) lines.push(`- \`${h}\``);
      lines.push("");
    }

    if (ips.length === 0 && hostnames.length === 0) {
      lines.push("No targets found in the session history.");
    }

    reply.ok(lines.join("\n"));
  },

  export: async ({ sessionId, userId, reply, loadSession }) => {
    const session = await loadSession();
    if (!session) return;

    const nonSystemMessages = session.messages.filter(
      (m: any) => m.role !== "system",
    );

    if (nonSystemMessages.length === 0) {
      reply.ok("Nothing to export — the session is empty.");
      return;
    }

    const structuredFindings = serializeFindingsForReport(session.vulnerabilities ?? []);

    const conversationText = await boundedConversationText(
      nonSystemMessages,
    );

    const reportSource = structuredFindings.length
      ? `${conversationText}\n\n<structured_vulnerabilities>\n${JSON.stringify(structuredFindings, null, 2)}\n</structured_vulnerabilities>`
      : conversationText;

    reply.ack("Generating report...");

    const result = await invoke_llm({
      messages: [
        {
          role: "system",
          content: `You are a professional penetration test report writer. Generate a structured pentest report from the engagement conversation. Use this format:

# Penetration Test Report

## Executive Summary
Brief overview of the engagement, methodology, and key findings.

## Scope
List of in-scope targets, IP addresses, networks.

## Findings

### Finding 1: [Title]
- **Severity:** Info/Low/Medium/High (derived from the likelihood x impact risk matrix — never declare Critical)
- **Affected Systems:** ...
- **Description:** ...
- **Evidence:** ...
- **Recommendation:** ...

(repeat for each finding)

## Tools Used
List of tools and their purpose.

## Recommendations
Prioritized remediation steps.

## Appendix
Any additional data, raw outputs, or notes.

Use markdown formatting. Be thorough but concise.`,
        },
        { role: "user", content: reportSource },
      ],
      temperature: 0.3,
      sessionId,
      userId,
      tags: ["slash-command", "export"],
      generationName: "slash-export-report",
    });

    reply.ok(result.content ?? "Failed to generate report.");
  },

  shells: async ({ sessionId, reply }) => {
    let shellManager;
    try {
      shellManager = await sessionLifecycle.getShellManager(sessionId);
    } catch {
      reply.ok("No shell manager available for this session.");
      return;
    }

    const shells = shellManager.getShellList();
    if (shells.length === 0) {
      reply.ok("No shells have been created in this session.");
      return;
    }

    const active = shells.filter((s) => s.status === "active");
    const closed = shells.filter((s) => s.status !== "active");

    const lines: string[] = [
      `### Shell Sessions`,
      ``,
      `**${active.length}** active, **${closed.length}** closed`,
      ``,
    ];

    if (active.length > 0) {
      lines.push("#### Active");
      for (const s of active) {
        lines.push(`- \`${s.shellId}\` — **${s.label}** (${s.type}, created by: ${s.createdBy})`);
      }
      lines.push("");
    }

    if (closed.length > 0) {
      lines.push("#### Closed");
      for (const s of closed) {
        lines.push(`- \`${s.shellId}\` — ${s.label} (${s.type})`);
      }
    }

    reply.ok(lines.join("\n"));
  },

  wstg: async ({ sessionId, args, reply }) => {
    const existing = await loadSessionPlan(sessionId);
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const target = tokens.join(" ").trim();

    if (!target && existing?.cases?.length) {
      const coverage = computeCoverage(existing.cases);
      const lines = [
        `### WSTG v${existing.version} test plan`,
        "",
        existing.target ? `**Target:** ${existing.target}` : "**Target:** not set — run `/wstg <target>` to set it",
        existing.scope ? `**Scope:** ${existing.scope}` : "",
        `**Coverage:** ${coverage.executed}/${coverage.total} executed (${coverage.percentExecuted}%) — ${coverage.passed} passed, ${coverage.failed} failed, ${coverage.blocked} blocked, ${coverage.notStarted} not started`,
        "",
        "**By category:** " +
          coverage.byCategory.map((row) => `${row.key} ${row.executed}/${row.total}`).join(", "),
        "",
        "**Next tests:**",
        ...nextTestsToRun(existing, 10).map(
          (testCase) => `- \`${testCase.testId}\` ${testCase.title}`,
        ),
        "",
        "Refresh or re-scope with `/wstg <target>`.",
      ];
      reply.ok(lines.filter(Boolean).join("\n"));
      return;
    }

    if (!target && !existing?.cases?.length) {
      reply.fail(
        "Usage: `/wstg <target>` — for example `/wstg https://app.example.com`. Plans the full OWASP WSTG catalogue; ask the assistant to restrict categories or add custom cases.",
      );
      return;
    }

    const result = createTestPlan({
      target: target || undefined,
      existing,
    });
    await saveSessionPlan(sessionId, result.plan);

    const coverage = result.coverage;
    const lines = [
      `### WSTG v${result.plan.version} test plan ${existing ? "updated" : "created"}`,
      "",
      `**Target:** ${result.plan.target || "not set"}`,
      `**Cases:** ${result.plan.cases.length} test cases (${result.added} added, ${result.kept} kept with their previous status)`,
      "",
      "**Start with:**",
      ...nextTestsToRun(result.plan, 10).map(
        (testCase) => `- \`${testCase.testId}\` (${testCase.section}) ${testCase.title}`,
      ),
      "",
      "Ask the assistant to work through the plan; it records each result with `wstg_test_plan` action `update_case`.",
      `Not started: ${coverage.notStarted} of ${coverage.total}.`,
    ];
    reply.ok(lines.join("\n"));
  },

  map: async ({ sessionId, reply }) => {
    const session = await SessionsModel.findOne({ sessionId })
      .select("vulnerabilities")
      .lean();
    if (!session) {
      reply.sessionMissing();
      return;
    }
    const vulnerabilities = (session.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
    if (!vulnerabilities.length) {
      reply.ok("No findings are tracked in this session yet, so there is nothing to map.");
      return;
    }

    const mapped = await mapUnclassifiedVulnerabilities(sessionId, vulnerabilities);
    const refreshed = await SessionsModel.findOne({ sessionId })
      .select("vulnerabilities")
      .lean();
    const rows = (refreshed?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];

    const lines: string[] = ["### OWASP Top 10:2025 mapping", ""];
    if (mapped > 0) lines.push(`${mapped} finding(s) were classified just now.`, "");

    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.owaspTop10 || "unmapped";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    lines.push("| Category | Findings |", "| --- | --- |");
    for (const [key, count] of Array.from(counts.entries()).sort()) {
      const category = key === "unmapped" ? undefined : getOwaspCategory(key);
      lines.push(
        `| ${category ? `${category.id} ${category.title}` : "Unmapped"} | ${count} |`,
      );
    }
    lines.push("", "**Findings**", "");
    for (const row of rows) {
      const category = row.owaspTop10 ? getOwaspCategory(row.owaspTop10) : undefined;
      lines.push(
        `- ${row.severity.toUpperCase()} ${row.title} (${row.host}) — ${category ? `${category.id} ${category.title}` : "unmapped"}${row.wstgId ? ` — \`${row.wstgId}\`` : ""}${row.owaspConfidence ? ` — ${row.owaspConfidence} confidence` : ""}`,
      );
    }

    const unmapped = rows.filter((row) => !row.owaspTop10);
    if (unmapped.length) {
      lines.push(
        "",
        `${unmapped.length} finding(s) still have no mapping. Ask the assistant to classify them with \`map_finding_owasp\`, adding a WSTG test id or CWE for the ones the classifier could not place.`,
      );
    }
    reply.ok(lines.join("\n"));
  },

  report: async ({ sessionId, reply }) => {
    const session = await SessionsModel.findOne({ sessionId })
      .select("name description createdAt vulnerabilities webAppTestPlan")
      .lean();
    if (!session) {
      reply.sessionMissing();
      return;
    }

    const report = buildWebAppPentestReport({
      session: {
        sessionId,
        name: session.name ?? "Engagement",
        description: session.description ?? "",
        createdAt: session.createdAt as unknown as Date,
      },
      vulnerabilities: (session.vulnerabilities ?? []) as SessionVulnerabilityDoc[],
      testPlan: (session.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null,
    });

    reply.ok(
      [`*File name for this draft: \`${report.fileName}\`*`, "", report.markdown].join("\n"),
    );
  },
};

