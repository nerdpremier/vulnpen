import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolIndex } from "./toolIndex.mjs";

test("tool results are indexed under their call id and hidden from the visible list", () => {
  const messages = [
    { id: "a", role: "user", content: "run it" },
    {
      id: "b",
      role: "assistant",
      toolCalls: [
        { id: "call-1", name: "wstg_test_plan", arguments: "{\"action\":\"get\"}" },
      ],
    },
    { id: "c", role: "tool", toolCallId: "call-1", content: "case detail" },
    { id: "d", role: "assistant", content: "done" },
  ];

  const { toolIndex, visibleMessages } = buildToolIndex(messages);
  assert.equal(toolIndex.outputs.get("call-1").id, "c");
  assert.equal(toolIndex.args.get("call-1"), "{\"action\":\"get\"}");
  assert.deepEqual(visibleMessages.map((m) => m.id), ["a", "b", "d"]);
});

test("a tool result with no matching call stays visible", () => {
  const messages = [
    { id: "x", role: "tool", toolCallId: "orphan", content: "leftover" },
  ];
  const { visibleMessages } = buildToolIndex(messages);
  assert.deepEqual(visibleMessages.map((m) => m.id), ["x"]);
});
