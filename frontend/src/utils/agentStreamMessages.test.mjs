import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LIVE_TOOL_CHARS,
  mergeToolChunk,
  applyToolOutputBuffer,
  patchMessage,
  applyToolDone,
  applyToolError,
  finalizeStreamedAssistant,
} from "./agentStreamMessages.mjs";

const toolMessage = (overrides = {}) => ({
  id: "tool_1",
  role: "tool",
  toolCallId: "1",
  toolName: "shell",
  content: "",
  streaming: true,
  ...overrides,
});

test("mergeToolChunk trims to the tail once past the live cap", () => {
  const existing = "x".repeat(MAX_LIVE_TOOL_CHARS);
  const merged = mergeToolChunk(existing, "tail");

  assert.ok(merged.startsWith("[... earlier output trimmed ...]\n"));
  assert.ok(merged.endsWith("tail"));
  assert.equal(merged.length, "[... earlier output trimmed ...]\n".length + MAX_LIVE_TOOL_CHARS);
});

test("applyToolOutputBuffer patches every matching message in one pass", () => {
  const messages = [
    toolMessage({ id: "tool_1", content: "a" }),
    { id: "asst_1", role: "assistant", content: "hi" },
    toolMessage({ id: "tool_2", content: "b" }),
  ];

  const next = applyToolOutputBuffer(messages, { tool_1: "+1", tool_2: "+2" });

  assert.equal(next[0].content, "a+1");
  assert.equal(next[1], messages[1]); // untouched message keeps identity
  assert.equal(next[2].content, "b+2");
});

test("applyToolOutputBuffer returns the same list when nothing buffered", () => {
  const messages = [toolMessage()];
  assert.equal(applyToolOutputBuffer(messages, {}), messages);
});

test("patchMessage only replaces the addressed message", () => {
  const messages = [
    { id: "a", content: "1" },
    { id: "b", content: "2" },
  ];

  const next = patchMessage(messages, "b", { content: "updated" });

  assert.equal(next[0], messages[0]);
  assert.equal(next[1].content, "updated");
  assert.equal(messages[1].content, "2"); // input not mutated
});

test("applyToolDone prefers streamed output and falls back to the server copy", () => {
  const streamed = toolMessage({ content: "streamed", streaming: true });
  const asserted = applyToolDone([streamed], {
    id: "1",
    output: "server",
    exitCode: 0,
    files: ["shot.png"],
  })[0];
  assert.equal(asserted.content, "streamed");
  assert.equal(asserted.streaming, false);
  assert.equal(asserted.exitCode, 0);
  assert.deepEqual(asserted.files, ["shot.png"]);

  const silent = toolMessage({ content: "" });
  const doneSilent = applyToolDone([silent], { id: "1", output: "server" })[0];
  assert.equal(doneSilent.content, "server");
});

test("applyToolError stamps the message with the failure", () => {
  const next = applyToolError([toolMessage()], { id: "1", error: "boom" })[0];

  assert.equal(next.content, "boom");
  assert.equal(next.streaming, false);
  assert.equal(next.exitCode, 1);
});

test("finalizeStreamedAssistant lands the final snapshot and clears flags", () => {
  const messages = [
    {
      id: "asst_1",
      role: "assistant",
      content: "partial",
      streaming: true,
      reasoningStreaming: true,
    },
  ];

  const next = finalizeStreamedAssistant(messages, {
    id: "asst_1",
    content: "full",
    reasoning: "because",
    toolCalls: [{ id: "t1", name: "shell", arguments: "{}" }],
  });

  assert.equal(next[0].content, "full");
  assert.equal(next[0].reasoning, "because");
  assert.equal(next[0].streaming, false);
  assert.equal(next[0].reasoningStreaming, false);
  assert.equal(next[0].toolCalls.length, 1);
});

test("finalizeStreamedAssistant leaves the list alone when the message is gone", () => {
  const messages = [{ id: "asst_1", role: "assistant" }];
  assert.equal(
    finalizeStreamedAssistant(messages, { id: "missing", content: "", reasoning: "", toolCalls: [] }),
    messages,
  );
});
