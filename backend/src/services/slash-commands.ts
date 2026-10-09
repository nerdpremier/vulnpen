import SessionsModel, { SessionDoc } from "../models/Sessions/Sessions.model";
import type { SSEWriter } from "../utils/sse";
import { createSlashReply, SlashReply } from "./slash-reply";
import { invoke_llm_streaming } from "../utils/llm/streaming";
import { sessionLifecycle } from "./session.lifecycle";
import { resetAgentRun } from "./session-transcript";
import {
  computeCoverage,
  createTestPlan,
  nextTestsToRun,
} from "./web-security/test-plan.service";
import {
  loadSessionPlan,
  saveSessionPlan,
} from "./web-security/session-plan-store";
import { boundedConversationText } from "./compaction.service";

/**
 * Slash commands are the shortcuts that have nowhere else to live: a chat-side
 * action with no page and no tool behind it. Anything that already has one — the
 * report (Report page and `generate_pentest_report`), the plan (Test plan page
 * and `wstg_test_plan`), bulk OWASP mapping (`map_finding_owasp` apply_to_all),
 * clearing the context (the context indicator's button) — is not repeated here,
 * because a second entry point is a second thing to keep in step.
 */

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
    name: "help",
    description: "List all available slash commands",
    usage: "/help",
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
   * handler only early-returns.
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
};

