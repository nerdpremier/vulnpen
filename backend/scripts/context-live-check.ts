/**
 * Live check for the context-compaction model.
 *
 * Drives the REAL planner and the REAL summarizer over a simulated long WSTG run
 * against the configured provider, so it answers what unit tests cannot:
 *   1. how many tool rounds pass between two summaries (the metric an operator
 *      feels when a run "summarizes every one or two commands");
 *   2. whether a narrative canary survives the real summarizer;
 *   3. how far the budget estimate is from the provider real prompt_tokens.
 *
 * Run: npx tsx scripts/context-live-check.ts
 * Costs a handful of provider calls; it is a script, not part of `npm test`.
 */
import { buildSystemPrompt, buildVolatileWebAppPrompt } from "../src/utils/assistant/prompts";
import {
  planCompaction,
  summarizeMessages,
  messagesToOpenAI,
  estimatePromptTokens,
  COMPACTION_TUNING,
  estimateToolSchemaTokens,
} from "../src/services/context.service";
import { toolRegistry } from "../src/tools/registry";
import { invoke_llm } from "../src/utils/llm/invoke";
import { getModelContextLimit } from "../src/utils/modelMetadata";
import { EngagementState } from "../src/services/engagement-state";
import type { AgentMessageDoc } from "../src/models/Sessions/Sessions.model";

const ROUNDS = 30;
const CANARY = "HYPOTHESIS-CANARY: /ftp leaks backups; next fetch /ftp/package.json.bak";

function toolOutput(i: number): string {
  const head = "$ nmap -sV -p- -T4 juice-shop\nStarting Nmap 7.94SVN\nNmap scan report for juice-shop (172.20.0.4)\n";
  const body = Array.from({ length: 70 }, (_, k) => "  " + (1000 + k * 3) + "/tcp  open  svc-" + k + "  syn-ack  service " + k + ".0").join("\n");
  const note = "\n" + "=".repeat(40) + "\ncase WSTG-ATHN-" + i + ": login throttle observation - the endpoint returned 200 on all 30 attempts, no account lockout and no rate-limit header. Raw evidence saved to /root/evidence/round-" + i + ".txt (re-read with cat only if the middle matters).\n";
  return head + body + note;
}

function analysis(i: number): string {
  return (
    "Case WSTG-ATHN-" + i + ": I stepped through the login endpoint. " +
    "The throttle control is absent: 30 rapid attempts all returned 200, no captcha, no delay, no lockout. " +
    "I compared anonymous vs authenticated responses and both expose the same error text, so user enumeration is also possible here. " +
    "Plan: record this as a failed ATHN case, link it to the existing authentication-failures finding, then move to the session cases. " +
    "If the run is interrupted before I finish, the next operator should re-run just the last three attempts to confirm."
  );
}

function pushRound(messages: AgentMessageDoc[], i: number, withCanary: boolean): void {
  const command =
    "curl -s -o /dev/null -w '%{http_code}' 'http://juice-shop:3000/rest/user/login' " +
    "-d '{\"email\":\"a@a.com\",\"password\":\"x\"}' -H 'X-Trace: " + "y".repeat(140) + "'";
  messages.push({
    id: "a" + i,
    role: "assistant",
    content: (withCanary ? CANARY + ". " : "") + analysis(i),
    toolCalls: [{ id: "c" + i, name: "run_bash", arguments: JSON.stringify({ command }) }],
    timestamp: new Date(),
    turnIndex: i,
  });
  messages.push({
    id: "t" + i,
    role: "tool",
    toolCallId: "c" + i,
    toolName: "run_bash",
    content: toolOutput(i),
    timestamp: new Date(),
    turnIndex: i,
  });
}

function fakePlan(): unknown {
  return {
    source: "WSTG v4.2",
    target: "http://juice-shop:3000",
    scope: "port 3000",
    cases: Array.from({ length: 97 }, (_, i) => ({
      testId: "WSTG-ATHN-" + i,
      category: "ATHN",
      section: "Authentication",
      title: "Authentication case " + i,
      objective: "Verify authentication control " + i,
      status: i < 32 ? "failed" : i < 60 ? "passed" : "not_started",
      observations: i < 32 ? "control " + i + " absent" : "",
      notes: "",
    })),
  };
}

function buildSystem(config: unknown): string {
  const sys = buildSystemPrompt(config as never);
  let volatile = "";
  try {
    volatile = buildVolatileWebAppPrompt(config as never);
  } catch {
    volatile = "";
  }
  return sys + "\n\n<volatile_system>\n" + volatile + "\n</volatile_system>";
}

async function main(): Promise<void> {
  const engagement = new EngagementState("pentest");
  engagement.declaredTarget = "http://juice-shop:3000";
  engagement.scope = "port 3000";
  engagement.services.push({ host: "juice-shop", port: 3000, protocol: "tcp", service: "http" });
  engagement.keyDiscoveries.push("no rate limiting on /rest/user/login");

  const config = {
    sessionId: "live-check",
    currentDate: "2026-01-01",
    currentDay: "Thursday",
    timezone: "UTC",
    engagement: { target: "http://juice-shop:3000", scope: "port 3000" },
    webAppSecurity: {
      testPlan: fakePlan(),
      findingCount: 3,
      unmappedFindingCount: 1,
      owaspBreakdown: [
        { id: "A01:2025", title: "Broken Access Control", findings: 2 },
        { id: "A07:2025", title: "Authentication Failures", findings: 1 },
      ],
    },
  };

  const messages: AgentMessageDoc[] = [
    { id: "sys", role: "system", content: buildSystem(config), timestamp: new Date(), turnIndex: 0 },
  ];
  const tools = toolRegistry.toOpenAISchemas({ agentRole: "main" });
  const toolSchemaTokens = estimateToolSchemaTokens(tools);

  pushRound(messages, 0, false);
  const cal = await invoke_llm({
    messages: messagesToOpenAI(messages),
    tools,
    temperature: 0,
    reasoningMode: "off",
    tags: ["live-check", "calibrate"],
  });
  const realPrompt = cal.usage?.prompt_tokens ?? 0;
  const estimate = estimatePromptTokens(messages) + toolSchemaTokens;
  const budget = Math.min(getModelContextLimit(cal.model) * 0.4, COMPACTION_TUNING.WORKING_SET_TOKEN_BUDGET);
  console.log("\n=== Live context-compaction check (model: " + cal.model + ") ===");
  console.log("budget: " + budget + " tokens");
  console.log(
    "calibration: real prompt_tokens=" + realPrompt + "  estimate=" + estimate + "  delta=" + (estimate - realPrompt) +
      " (" + (((estimate - realPrompt) / Math.max(realPrompt, 1)) * 100).toFixed(1) + "%)",
  );

  let lastPromptTokens: number | undefined = realPrompt;
  const summaryRounds: number[] = [];
  let canaryKept = false;

  for (let round = 1; round <= ROUNDS; round++) {
    pushRound(messages, round, round === 2);
    const plan = await planCompaction(messages, lastPromptTokens, toolSchemaTokens);
    if (!plan.shouldCompact) continue;

    const started = Date.now();
    const { summaryMessage, preservedMessages, projectedPromptTokens } = await summarizeMessages(
      messages,
      undefined,
      engagement,
      toolSchemaTokens,
    );
    summaryRounds.push(round);
    if (summaryRounds.length === 1 && summaryMessage) {
      canaryKept = /HYPOTHESIS-CANARY|ftp|backup/i.test(summaryMessage.content ?? "");
      console.log("--- first summary text ---\n" + (summaryMessage.content ?? "").slice(0, 1800) + "\n--- end ---");
    }
    console.log(
      "  round " + round + ": SUMMARIZED reason=" + plan.reason + " promptTokens=" + plan.promptTokens +
        " -> projected=" + projectedPromptTokens + " (" + (Date.now() - started) + "ms, summaryChars=" + (summaryMessage?.content.length ?? 0) + ")",
    );
    messages.splice(0, messages.length, ...preservedMessages);
    lastPromptTokens = projectedPromptTokens;
  }

  const gaps = summaryRounds.map((r, i) => r - (summaryRounds[i - 1] ?? 0));
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : ROUNDS;
  const firstGap = summaryRounds[0] ?? ROUNDS;
  console.log("\nsummaries: " + summaryRounds.length + " over " + ROUNDS + " rounds (at rounds: " + (summaryRounds.join(", ") || "none") + ")");
  console.log("average tool rounds between summaries: " + avgGap.toFixed(1));
  console.log("canary kept in first summary: " + (canaryKept ? "YES" : "NO"));
  const ok = firstGap >= 4 && avgGap >= 3;
  console.log("\nverdict: " + (ok ? "PASS" : "FAIL") + " - " + firstGap + " rounds before the first summary, " + avgGap.toFixed(1) + " avg (thrash would be 1-2).");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("live check failed:", err);
  process.exit(1);
});