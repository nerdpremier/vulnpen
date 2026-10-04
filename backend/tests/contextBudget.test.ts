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
