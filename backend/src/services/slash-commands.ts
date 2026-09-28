import SessionsModel from "../models/Sessions/Sessions.model";
import { SSEWriter } from "./agent.service";
import { invoke_llm, invoke_llm_streaming, getProvider } from "../utils/llm/providers";
import { getModelContextLimit } from "../utils/modelMetadata";
import { sessionLifecycle } from "./session.lifecycle";
import { focusSessionOnChallenge } from "./ctf.service";
import { getOwaspCategory } from "../knowledge";
import type {
  SessionVulnerabilityDoc,
  WebAppTestPlanDoc,
} from "../models/Sessions/Sessions.model";
import {
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
  TEST_PLAN_DEPTHS,
} from "./web-security/test-plan.service";
import { buildWebAppPentestReport } from "./web-security/report.service";
import { mapUnclassifiedVulnerabilities } from "./vulnerability.service";

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
    name: "solve",
    description: "Focus on a specific CTF challenge (auto-suggests from synced challenges)",
    usage: "/solve <challenge_name> [extra notes]",
    args: [{ name: "challenge", required: true, description: "Challenge name or partial match" }],
  },
  {
    name: "wstg",
    description:
      "Create, refresh or show the OWASP WSTG v4.2 test plan for this session",
    usage: "/wstg [smoke|standard|deep|full] [target]",
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
  if (!handler) {
    sse.write("slash_command_result", {
      command,
      success: false,
      content: `Unknown command \`/${command}\`. Type \`/help\` to see available commands.`,
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
    return;
  }

  try {
    await handler({ sessionId, userId, args, sse });
  } catch (err: any) {
    console.error(`[slash-command] /${command} error:`, err);
    sse.write("slash_command_result", {
      command,
      success: false,
      content: `Error executing \`/${command}\`: ${err.message ?? "Unknown error"}`,
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  }
}

type CommandHandler = (ctx: {
  sessionId: string;
  userId: string;
  args: string;
  sse: SSEWriter;
}) => Promise<void>;

const CHARS_PER_TOKEN_ESTIMATE = 3.5;
const SUMMARIZE_PROMPT_OVERHEAD_TOKENS = 500;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

async function getMaxInputTokens(): Promise<number> {
  const config = await getProvider();
  const limit = getModelContextLimit(config.model);
  return Math.floor(limit * 0.6) - SUMMARIZE_PROMPT_OVERHEAD_TOKENS;
}

function formatMessageForSummary(m: any): string {
  if (m.role === "assistant" && m.toolCalls?.length) {
    const toolDesc = m.toolCalls
      .map((tc: any) => `[Tool: ${tc.name}](${tc.arguments})`)
      .join(", ");
    return `Assistant: ${m.content ?? ""} ${toolDesc}`;
  }
  if (m.role === "tool") {
    return `Tool Result (${m.toolName ?? "unknown"}): ${m.content?.slice(0, 500) ?? ""}`;
  }
  return `${m.role}: ${m.content ?? ""}`;
}

/**
 * Builds conversation text for the summarize prompt, keeping the latest
 * messages when the full history would exceed the model's input token budget.
 */
async function buildConversationTextForSummarize(messages: any[]): Promise<string> {
  const maxTokens = await getMaxInputTokens();

  const formatted = messages.map(formatMessageForSummary);

  const fullText = formatted.join("\n\n");
  if (estimateTokens(fullText) <= maxTokens) {
    return fullText;
  }

  const kept: string[] = [];
  let tokenBudget = maxTokens;

  for (let i = formatted.length - 1; i >= 0; i--) {
    const entry = formatted[i];
    const entryTokens = estimateTokens(entry) + 2;
    if (tokenBudget - entryTokens < 0) break;
    kept.unshift(entry);
    tokenBudget -= entryTokens;
  }

  return kept.join("\n\n");
}

const commandHandlers: Record<string, CommandHandler> = {
  help: async ({ sse }) => {
    const lines = SLASH_COMMANDS.map(
      (cmd) => `**\`/${cmd.name}\`** — ${cmd.description}`,
    );
    sse.write("slash_command_result", {
      command: "help",
      success: true,
      content: `### Available Commands\n\n${lines.join("\n\n")}`,
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  clear: async ({ sessionId, sse }) => {
    const session = await SessionsModel.findOne({ sessionId });
    if (!session) {
      sse.write("slash_command_result", { command: "clear", success: false, content: "Session not found." });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const systemMsg = session.messages?.find((m: any) => m.role === "system" && !m.isSummary);

    await SessionsModel.updateOne(
      { sessionId },
      {
        $set: {
          messages: systemMsg ? [systemMsg] : [],
          subagents: [],
          agentState: "idle",
          pendingConsent: null,
          pendingManualExecution: null,
        },
      },
    );

    sse.write("slash_command_result", {
      command: "clear",
      success: true,
      content: "Context cleared. Session history has been reset.",
      action: "clear_messages",
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  reset: async ({ sessionId, sse }) => {
    await SessionsModel.updateOne(
      { sessionId },
      {
        $set: {
          agentState: "idle",
          pendingConsent: null,
          pendingManualExecution: null,
        },
      },
    );

    sse.write("slash_command_result", {
      command: "reset",
      success: true,
      content: "Agent state has been reset to idle.",
      action: "reset_state",
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  summarize: async ({ sessionId, userId, sse }) => {
    const session = await SessionsModel.findOne({ sessionId });
    if (!session) {
      sse.write("slash_command_result", { command: "summarize", success: false, content: "Session not found." });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const nonSystemMessages = session.messages.filter(
      (m: any) => m.role !== "system",
    );

    if (nonSystemMessages.length === 0) {
      sse.write("slash_command_result", {
        command: "summarize",
        success: true,
        content: "Nothing to summarize — the session is empty.",
      });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const conversationText = await buildConversationTextForSummarize(nonSystemMessages);

    const resultId = `slash_result_${Date.now()}`;
    sse.write("slash_command_ack", { command: "summarize", message: "Generating summary..." });

    sse.write("slash_command_result", {
      command: "summarize",
      success: true,
      content: "",
      streaming: true,
      id: resultId,
    });

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
          sse.write("slash_command_stream", {
            command: "summarize",
            id: resultId,
            content: delta.content,
          });
        }
      },
    });

    sse.write("slash_command_done", {
      command: "summarize",
      id: resultId,
      content: accumulated || result.content || "Failed to generate summary.",
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  status: async ({ sessionId, sse }) => {
    const session = await SessionsModel.findOne({ sessionId });
    if (!session) {
      sse.write("slash_command_result", { command: "status", success: false, content: "Session not found." });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const lines: string[] = [];

    lines.push(`### Session Status`);
    lines.push(``);
    lines.push(`- **Session ID:** \`${sessionId}\``);
    lines.push(`- **Agent State:** ${session.agentState}`);
    lines.push(`- **Messages:** ${session.messages.length}`);
    lines.push(`- **Turn Index:** ${session.turnIndex}`);
    lines.push(`- **Total Tokens Used:** ${session.totalTokens?.toLocaleString() ?? 0}`);

    const subagents = session.subagents ?? [];
    if (subagents.length > 0) {
      lines.push(``);
      lines.push(`#### Subagents`);
      for (const s of subagents) {
        lines.push(`- \`${s.subagentId}\` — ${s.task} (${s.status})`);
      }
    }

    sse.write("slash_command_result", {
      command: "status",
      success: true,
      content: lines.join("\n"),
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  targets: async ({ sessionId, sse }) => {
    const session = await SessionsModel.findOne({ sessionId });
    if (!session) {
      sse.write("slash_command_result", { command: "targets", success: false, content: "Session not found." });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const allContent = session.messages
      .map((m: any) => m.content ?? "")
      .join("\n");

    const ipv4Pattern = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/g;
    const hostnamePattern = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;

    const ips = [...new Set(allContent.match(ipv4Pattern) ?? [])];
    const hostnames = [...new Set(allContent.match(hostnamePattern) ?? [])].filter(
      (h) => !h.match(/\.(js|ts|py|txt|json|xml|html|css|scss|md|log|csv|pdf|png|jpg)$/i),
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

    sse.write("slash_command_result", {
      command: "targets",
      success: true,
      content: lines.join("\n"),
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  export: async ({ sessionId, userId, sse }) => {
    const session = await SessionsModel.findOne({ sessionId });
    if (!session) {
      sse.write("slash_command_result", { command: "export", success: false, content: "Session not found." });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const nonSystemMessages = session.messages.filter(
      (m: any) => m.role !== "system",
    );

    if (nonSystemMessages.length === 0) {
      sse.write("slash_command_result", {
        command: "export",
        success: true,
        content: "Nothing to export — the session is empty.",
      });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const conversationText = nonSystemMessages
      .map((m: any) => {
        if (m.role === "assistant" && m.toolCalls?.length) {
          const toolDesc = m.toolCalls
            .map((tc: any) => `[Tool: ${tc.name}](${tc.arguments})`)
            .join(", ");
          return `Assistant: ${m.content ?? ""} ${toolDesc}`;
        }
        if (m.role === "tool") {
          return `Tool Result (${m.toolName ?? "unknown"}): ${m.content?.slice(0, 1000) ?? ""}`;
        }
        return `${m.role}: ${m.content ?? ""}`;
      })
      .join("\n\n");

    const structuredFindings = (session.vulnerabilities ?? []).map((v) => ({
      id: v.vulnerabilityId,
      title: v.title,
      severity: v.severity,
      cvssScore: v.cvssScore,
      cvssVector: v.cvssVector,
      cwe: v.cwe,
      cve: v.cve,
      host: v.host,
      service: v.service,
      endpoint: v.endpoint,
      description: v.description,
      contextSummary: v.contextSummary,
      evidence: v.evidence,
      stepsToReproduce: v.stepsToReproduce,
      impact: v.impact,
      remediation: v.remediation,
      exploited: v.exploited,
      status: v.status,
    }));

    const reportSource = structuredFindings.length
      ? `${conversationText}\n\n<structured_vulnerabilities>\n${JSON.stringify(structuredFindings, null, 2)}\n</structured_vulnerabilities>`
      : conversationText;

    sse.write("slash_command_ack", { command: "export", message: "Generating report..." });

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
- **Severity:** Critical/High/Medium/Low/Info
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

    sse.write("slash_command_result", {
      command: "export",
      success: true,
      content: result.content ?? "Failed to generate report.",
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  shells: async ({ sessionId, sse }) => {
    let shellManager;
    try {
      shellManager = await sessionLifecycle.getShellManager(sessionId);
    } catch {
      sse.write("slash_command_result", {
        command: "shells",
        success: true,
        content: "No shell manager available for this session.",
      });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    const shells = shellManager.getShellList();
    if (shells.length === 0) {
      sse.write("slash_command_result", {
        command: "shells",
        success: true,
        content: "No shells have been created in this session.",
      });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
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

    sse.write("slash_command_result", {
      command: "shells",
      success: true,
      content: lines.join("\n"),
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },

  solve: async ({ sessionId, args, sse }) => {
    const fail = (content: string) => {
      sse.write("slash_command_result", { command: "solve", success: false, content });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
    };

    if (args.toLowerCase() === "clear" || args.toLowerCase() === "none") {
      await SessionsModel.updateOne({ sessionId }, { $unset: { "ctfConfig.activeSolve": 1 } });
      sse.write("slash_command_result", {
        command: "solve",
        success: true,
        content: "Challenge focus cleared. The agent will no longer target a specific challenge.",
      });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
      return;
    }

    if (!args.trim()) {
      fail(
        "Usage: `/solve <challenge_name>` — specify which challenge to focus on.\nUse `/solve clear` to deactivate challenge focus.",
      );
      return;
    }

    // `/solve "name with spaces" extra notes` — quoted name, rest is notes.
    let query = args.replace(/^["']|["']$/g, "").trim();
    let userNotes = "";
    const quoted = args.match(/^["'](.+?)["']\s*(.*)/);
    if (quoted) {
      query = quoted[1].trim();
      userNotes = quoted[2].trim();
    }

    const result = await focusSessionOnChallenge({
      sessionId,
      query,
      userNotes,
      syncWorkspaceActiveSolve: true,
    });

    if (!result.ok) {
      const listing = result.candidates?.length
        ? `\n\n### Available challenges:\n${result.candidates.map((c) => `- **${c}**`).join("\n")}`
        : "";
      fail(`${result.message}${listing}`);
      return;
    }

    const ch = result.challenge;
    const lines: string[] = [
      `### Solving: ${ch.name}`,
      ``,
      `**Category:** ${ch.category} | **Points:** ${ch.points}`,
      `**Working directory:** \`${ch.challengeDir}\``,
      ``,
      ch.challengeTxt.includes("Description:") ? "" : `${ch.challengeTxt}\n`,
      ch.files.length > 0
        ? `**Files:**\n${ch.files.map((f) => `- \`${ch.challengeDir}/${f}\``).join("\n")}`
        : "*No attached files*",
    ];

    if (userNotes) {
      lines.push("", `**Your notes:** ${userNotes}`);
    }

    lines.push("", "The agent is now focused on this challenge. Send a message to start solving, or add more context.");

    sse.write("slash_command_result", {
      command: "solve",
      success: true,
      content: lines.filter((l) => l !== undefined).join("\n"),
    });
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  },
  wstg: async ({ sessionId, args, sse }) => {
    const finish = (content: string, success = true) => {
      sse.write("slash_command_result", { command: "wstg", success, content });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
    };

    try {
      const session = await SessionsModel.findOne({ sessionId })
        .select("webAppTestPlan")
        .lean();
      const existing = (session?.webAppTestPlan as WebAppTestPlanDoc | undefined) ?? null;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const depthToken = tokens.find((token) =>
        TEST_PLAN_DEPTHS.some((depth) => depth.id === token.toLowerCase()),
      );
      const target = tokens.filter((token) => token !== depthToken).join(" ").trim();

      const depthHelp = TEST_PLAN_DEPTHS.map(
        (depth) => `- \`${depth.id}\` (${depth.testCount} cases) — ${depth.description}`,
      ).join("\n");

      if (!target && !depthToken && existing?.cases?.length) {
        const coverage = computeCoverage(existing.cases);
        const lines = [
          `### WSTG v${existing.version} test plan (depth: ${existing.depth})`,
          "",
          existing.target ? `**Target:** ${existing.target}` : "**Target:** not set — run `/wstg <target>` to set it",
          existing.scope ? `**Scope:** ${existing.scope}` : "",
          `**Coverage:** ${coverage.executed}/${coverage.total} executed (${coverage.percentExecuted}%) — ${coverage.passed} passed, ${coverage.failed} failed, ${coverage.blocked} blocked, ${coverage.notStarted} not started`,
          "",
          "**By category:** " +
            coverage.byCategory.map((row) => `${row.key} ${row.executed}/${row.total}`).join(", "),
          "",
          "**Next by priority:**",
          ...nextTestsToRun(existing, 10).map(
            (testCase) => `- \`${testCase.testId}\` ${testCase.title} — ${testCase.owasp.join(", ")}`,
          ),
          "",
          "Refresh or re-scope with `/wstg <depth> <target>`.",
        ];
        finish(lines.filter(Boolean).join("\n"));
        return;
      }

      if (!target && !existing?.cases?.length) {
        finish(
          `Usage: \`/wstg [depth] [target]\` — for example \`/wstg standard https://app.example.com\`.\n\n${depthHelp}`,
          false,
        );
        return;
      }

      const result = createTestPlan({
        target: target || undefined,
        depth: depthToken,
        existing,
      });
      await SessionsModel.updateOne(
        { sessionId },
        { $set: { webAppTestPlan: result.plan } },
      );

      const coverage = result.coverage;
      const lines = [
        `### WSTG v${result.plan.version} test plan ${existing ? "updated" : "created"}`,
        "",
        `**Target:** ${result.plan.target || "not set"}`,
        `**Depth:** ${result.plan.depth} — ${result.plan.cases.length} test cases (${result.added} added, ${result.kept} kept with their previous status)`,
        "",
        "**Start with:**",
        ...nextTestsToRun(result.plan, 10).map(
          (testCase) => `- \`${testCase.testId}\` (${testCase.section}) ${testCase.title} — ${testCase.owasp.join(", ")}`,
        ),
        "",
        "Ask the assistant to work through the plan; it records each result with `wstg_test_plan` action `update_case`.",
        `Not started: ${coverage.notStarted} of ${coverage.total}.`,
      ];
      finish(lines.join("\n"));
    } catch (err: any) {
      finish(`Error building the WSTG test plan: ${err?.message ?? err}`, false);
    }
  },

  map: async ({ sessionId, sse }) => {
    const finish = (content: string, success = true) => {
      sse.write("slash_command_result", { command: "map", success, content });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
    };

    try {
      const session = await SessionsModel.findOne({ sessionId })
        .select("vulnerabilities")
        .lean();
      const vulnerabilities = (session?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
      if (!vulnerabilities.length) {
        finish("No findings are tracked in this session yet, so there is nothing to map.");
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
      finish(lines.join("\n"));
    } catch (err: any) {
      finish(`Error mapping findings: ${err?.message ?? err}`, false);
    }
  },

  report: async ({ sessionId, sse }) => {
    const finish = (content: string, success = true) => {
      sse.write("slash_command_result", { command: "report", success, content });
      sse.write("done", { message: "Slash command completed" });
      sse.end();
    };

    try {
      const session = await SessionsModel.findOne({ sessionId })
        .select("name description createdAt vulnerabilities webAppTestPlan")
        .lean();
      if (!session) {
        finish("Session not found.", false);
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

      finish(
        [`*File name for this draft: \`${report.fileName}\`*`, "", report.markdown].join("\n"),
      );
    } catch (err: any) {
      finish(`Error generating the report draft: ${err?.message ?? err}`, false);
    }
  },};

