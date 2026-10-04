import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesToOpenAI } from "../src/services/context.service";
import type { AgentMessageDoc } from "../src/models/Sessions/Sessions.model";

const assistantTurn: AgentMessageDoc = {
  id: "assistant-1",
  role: "assistant",
  content: null,
  reasoning: "I should inspect the target first.",
  toolCalls: [{ id: "call-1", name: "lookup_target", arguments: '{"target":"example.com"}' }],
  timestamp: new Date(0),
  turnIndex: 1,
};

const toolTurn: AgentMessageDoc = {
  id: "tool-1",
  role: "tool",
  content: "93.184.216.34",
  toolCallId: "call-1",
  toolName: "lookup_target",
  timestamp: new Date(0),
  turnIndex: 1,
};

test("Kimi continuation preserves reasoning_content with tool calls", () => {
  const converted = messagesToOpenAI([assistantTurn, toolTurn], true);
  assert.equal((converted[0] as { reasoning_content?: string }).reasoning_content, assistantTurn.reasoning);
  assert.equal(converted[0].role, "assistant");
  assert.equal(converted[1].role, "tool");
});

test("standard OpenAI-compatible messages omit provider-specific reasoning_content", () => {
  const converted = messagesToOpenAI([assistantTurn, toolTurn]);
  assert.equal("reasoning_content" in converted[0], false);
});

test("Kimi reasoning replay is limited to the recent window", () => {
  const old = (i: number): AgentMessageDoc => ({
    id: `assistant-old-${i}`,
    role: "assistant",
    content: `old analysis ${i}`,
    reasoning: `old reasoning ${i} — routinely several times longer than the visible text`,
    timestamp: new Date(0),
    turnIndex: i,
  });
  const filler = (i: number): AgentMessageDoc => ({
    id: `user-${i}`,
    role: "user",
    content: "continue",
    timestamp: new Date(0),
    turnIndex: i,
  });
  // history of 12 messages: only the last PRESERVE_RECENT_MESSAGES (6) keep
  // reasoning_content; older reasoning is dead weight on every iteration.
  const history = [
    old(1), filler(1), old(2), filler(2), old(3), filler(3),
    old(4), filler(4), old(5), filler(5), old(6), filler(6),
  ];
  const converted = messagesToOpenAI(history, true) as Array<{
    role: string;
    content?: string | null;
    reasoning_content?: string;
  }>;
  const withReasoning = converted.filter((m) => m.reasoning_content);
  assert.ok(withReasoning.length > 0, "recent assistant messages keep reasoning");
  for (const m of withReasoning) {
    assert.match(m.reasoning_content!, /old reasoning [456]/);
  }
  assert.ok(
    !converted.some((m) => m.reasoning_content?.includes("old reasoning 1")),
    "older reasoning is dropped",
  );
});
