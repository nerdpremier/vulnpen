import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finalizeAbortedToolCalls,
  ABORTED_TOOL_MARKER,
} from "./finalizeAbortedToolCalls.mjs";

const streamingTool = (overrides = {}) => ({
  id: "tool_abc",
  role: "tool",
  toolCallId: "abc",
  toolName: "browser_action",
  args: { url: "https://example.com" },
  content: "Navigated to https://example.com",
  streaming: true,
  ...overrides,
});

test("finalizeAbortedToolCalls marks a streaming tool as finished", () => {
  const messages = [streamingTool()];

  const [done] = finalizeAbortedToolCalls(messages);

  assert.equal(done.streaming, false);
  assert.equal(
    done.content,
    `Navigated to https://example.com\n${ABORTED_TOOL_MARKER}`,
  );
  // Re-running on a message that is already finalised is a no-op.
  assert.equal(finalizeAbortedToolCalls([done])[0].content, done.content);
});

test("finalizeAbortedToolCalls keeps every other message identical", () => {
  const finished = streamingTool({ id: "tool_done", streaming: false, exitCode: 0 });
  const pending = streamingTool({ id: "tool_pending" });
  const assistant = {
    id: "asst_1",
    role: "assistant",
    content: "thinking",
    streaming: true,
  };
  const input = [finished, assistant, pending, { id: "tool_no_content", role: "tool", streaming: true }];

  const output = finalizeAbortedToolCalls(input);

  // Untouched messages must keep their identity so memoized blocks skip work.
  assert.equal(output[0], finished);
  assert.equal(output[1], assistant);
  assert.notEqual(output[2], pending);
  assert.equal(output[2].streaming, false);
  // A tool that never produced output still gets the marker, not "undefined".
  assert.equal(output[3].content, ABORTED_TOOL_MARKER);
});

test("finalizeAbortedToolCalls returns the input when there is nothing to do", () => {
  const finishedOnly = [streamingTool({ streaming: false })];
  assert.equal(finalizeAbortedToolCalls(finishedOnly), finishedOnly);
  const empty = [];
  assert.equal(finalizeAbortedToolCalls(empty), empty);
  assert.equal(finalizeAbortedToolCalls(undefined), undefined);
  assert.equal(finalizeAbortedToolCalls(null), null);
});