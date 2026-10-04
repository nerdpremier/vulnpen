import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesToOpenAI } from "../src/services/context.service";
import type { AgentMessageDoc } from "../src/models/Sessions/Sessions.model";

function doc(p: Partial<AgentMessageDoc>): AgentMessageDoc {
  return { id: "x", role: "tool", content: "", timestamp: new Date(0), turnIndex: 0, ...p } as AgentMessageDoc;
}

test("old oversized tool results collapse to a small head+tail stub", () => {
  const big = "A".repeat(12000);
  const msgs: AgentMessageDoc[] = [
    doc({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_bash", arguments: "{}" }] }),
    doc({ toolCallId: "c1", toolName: "run_bash", content: big }),
  ];
  // push 30 filler messages so the tool result is outside the recent window
  for (let i = 0; i < 30; i++) msgs.push(doc({ id: `f${i}`, role: "user", content: "filler" }));
  const out = messagesToOpenAI(msgs) as Array<{ role: string; content?: string }>;
  const tool = out.find((m) => m.role === "tool");
  assert.ok(tool!.content!.length < 1000);
  assert.match(tool!.content!, /elided from context/);
});

test("recent tool results are capped at the recent ceiling", () => {
  const big = "B".repeat(12000);
  const msgs: AgentMessageDoc[] = [
    doc({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "c2", name: "run_bash", arguments: "{}" }] }),
    doc({ toolCallId: "c2", toolName: "run_bash", content: big }),
  ];
  const out = messagesToOpenAI(msgs) as Array<{ role: string; content?: string }>;
  const tool = out.find((m) => m.role === "tool");
  assert.ok(tool!.content!.length < 6500);
  assert.ok(tool!.content!.startsWith("BBBB"));
  assert.ok(tool!.content!.endsWith("BBBB"));
});

test("old tool-call arguments collapse to a stub", () => {
  const args = JSON.stringify({ command: "nmap " + "x".repeat(2000) });
  const msgs: AgentMessageDoc[] = [
    doc({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "c3", name: "run_bash", arguments: args }] }),
    doc({ toolCallId: "c3", toolName: "run_bash", content: "ok" }),
  ];
  for (let i = 0; i < 30; i++) msgs.push(doc({ id: `f${i}`, role: "user", content: "filler" }));
  const out = messagesToOpenAI(msgs) as Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>;
  const assistant = out.find((m) => m.role === "assistant")!;
  assert.ok(assistant.tool_calls![0].function.arguments.length < 700);
  assert.match(assistant.tool_calls![0].function.arguments, /elided/);
});

// ─── Compaction planning ────────────────────────────────────────────────
// The regression these cover: a 97-case run summarized after every one or two
// tool calls, because the cached pre-summary prompt size was never reset and
// nothing stopped a summary that could not free any space.

import {
  planCompaction,
  messagesSinceSummary,
  estimatePromptTokens,
  COMPACTION_TUNING,
  selectPreservedWindow,
} from "../src/services/context.service";

function turn(i: number, chars: number): AgentMessageDoc {
  return doc({
    id: `t${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: "C".repeat(chars),
    turnIndex: i,
  });
}

test("messagesSinceSummary counts only what came after the last summary", () => {
  const msgs: AgentMessageDoc[] = [
    doc({ id: "s", role: "system", content: "summary", isSummary: true }),
    turn(1, 10),
    turn(2, 10),
    turn(3, 10),
  ];
  assert.equal(messagesSinceSummary(msgs), 3);
  assert.equal(messagesSinceSummary([turn(1, 10), turn(2, 10)]), 2);
});

test("estimatePromptTokens respects the tool-output caps instead of raw content", () => {
  const big = "R".repeat(60_000);
  const msgs: AgentMessageDoc[] = [
    doc({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "c9", name: "run_bash", arguments: "{}" }] }),
    doc({ toolCallId: "c9", toolName: "run_bash", content: big }),
  ];
  // Raw content alone is ~17k tokens; the rendered prompt is capped at ~700.
  const tokens = estimatePromptTokens(msgs);
  assert.ok(tokens < 1_500, `expected a capped estimate, got ${tokens}`);
});

test("planCompaction refuses to re-summarize right after a summary (cooldown)", async () => {
  const msgs: AgentMessageDoc[] = [
    doc({ id: "sys", role: "system", content: "system prompt " + "S".repeat(40_000) }),
    doc({ id: "s1", role: "system", content: "previous summary", isSummary: true }),
    turn(1, 4000),
    turn(2, 4000),
  ];
  const plan = await planCompaction(msgs, 60_000);
  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, "cooldown");
});

test("planCompaction refuses a summary that would free nothing", async () => {
  // One huge system prompt and a handful of tiny messages: the prompt is over
  // budget, but summarizing the tail cannot shrink it.
  const msgs: AgentMessageDoc[] = [
    doc({ id: "sys", role: "system", content: "S".repeat(200_000) }),
    ...Array.from({ length: 20 }, (_, i) => turn(i, 5)),
  ];
  const plan = await planCompaction(msgs, 200_000);
  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, "insufficient-savings");
});

test("planCompaction summarizes a long history with no prior summary", async () => {
  const msgs: AgentMessageDoc[] = [
    doc({ id: "sys", role: "system", content: "system prompt " + "S".repeat(6_000) }),
    ...Array.from({ length: 40 }, (_, i) => turn(i, 3_000)),
  ];
  const plan = await planCompaction(msgs, 40_000);
  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.reason, "over-budget");
  assert.ok(plan.projectedPromptTokens < plan.promptTokens);
});

test("compaction cooldown and savings guards are exposed for tuning", () => {
  assert.ok(COMPACTION_TUNING.MIN_MESSAGES_BEFORE_RECOMPACT >= 4);
  assert.ok(COMPACTION_TUNING.MIN_COMPACTION_SAVINGS_RATIO > 0);
  assert.ok(COMPACTION_TUNING.MIN_NEW_TOKENS_BEFORE_RECOMPACT > 0);
  assert.ok(COMPACTION_TUNING.RECENT_WINDOW_TOKEN_BUDGET > 0);
  assert.ok(COMPACTION_TUNING.MAX_PRESERVE_MESSAGES >= COMPACTION_TUNING.MIN_PRESERVE_MESSAGES);
});
// ─── Anti-thrash guarantees ─────────────────────────────────────────────
// These lock in the three defects that made a long run summarize every one or
// two tool calls: a double-counted fixed overhead, no post-summary headroom, and
// a cooldown that only counted messages.

test("the budget counts the real prompt once (no fixed-overhead double count)", async () => {
  // A ~8.6k-token system prompt plus a handful of tiny turns is ~11.8k tokens
  // with the tool schemas — comfortably within 18k. The old model added a fixed
  // overhead constant on top of an estimate that already contained the system
  // prompt, so this minimal, healthy session looked over budget.
  const msgs: AgentMessageDoc[] = [
    doc({ id: "sys", role: "system", content: "S".repeat(30_000) }),
    ...Array.from({ length: 4 }, (_, i) => turn(i, 20)),
  ];
  const plan = await planCompaction(msgs);
  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, "within-budget");
  assert.ok(plan.promptTokens < 15_000, "expected an honest count, got " + plan.promptTokens);
});

test("compaction lands the prompt well below budget (headroom, not a re-trigger)", async () => {
  const msgs: AgentMessageDoc[] = [
    doc({ id: "sys", role: "system", content: "system prompt " + "S".repeat(6_000) }),
    ...Array.from({ length: 30 }, (_, i) => turn(i, 2_000)),
  ];
  const plan = await planCompaction(msgs);
  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.reason, "over-budget");
  assert.ok(plan.projectedPromptTokens < plan.budget, "compaction must leave headroom below budget");
  assert.ok(
    plan.projectedPromptTokens < plan.promptTokens * 0.75,
    "compaction must free substantial space",
  );
});

test("the preserved window is bounded by tokens, not a fixed message count", () => {
  const msgs: AgentMessageDoc[] = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(
      doc({
        id: "a" + i,
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "c" + i, name: "run_bash", arguments: "{}" }],
      }),
    );
    msgs.push(
      doc({ id: "r" + i, role: "tool", toolCallId: "c" + i, toolName: "run_bash", content: "R".repeat(2_500) }),
    );
  }
  const { toPreserve, toSummarize } = selectPreservedWindow(msgs);
  assert.ok(toSummarize.length > 0, "something must be left to summarize");
  assert.ok(toPreserve.length < msgs.length, "a large history is not preserved whole");
  assert.ok(
    estimatePromptTokens(toPreserve) <= COMPACTION_TUNING.RECENT_WINDOW_TOKEN_BUDGET + 1_000,
    "the verbatim window stays near the token budget",
  );
});

test("the recompaction cooldown also requires new tokens, not just new messages", async () => {
  // 10 tiny messages satisfy the message count (>= 8) while barely growing the
  // prompt, so the token arm — not the message arm — is what blocks a needless
  // summary here.
  const msgs: AgentMessageDoc[] = [
    doc({ id: "sys", role: "system", content: "system prompt " + "S".repeat(60_000) }),
    doc({ id: "s1", role: "system", content: "previous summary", isSummary: true }),
    ...Array.from({ length: 10 }, (_, i) => turn(i, 20)),
  ];
  const plan = await planCompaction(msgs);
  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, "cooldown");
});