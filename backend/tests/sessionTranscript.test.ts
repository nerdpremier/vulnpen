import { test } from "node:test";
import assert from "node:assert/strict";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
  systemNoteMessage,
} from "../src/services/session-transcript";

test("message constructors stamp role, id, timestamp and turn index", () => {
  const user = userMessage("scan the target", 3);
  assert.equal(user.role, "user");
  assert.equal(user.content, "scan the target");
  assert.equal(user.turnIndex, 3);
  assert.ok(user.id);
  assert.ok(user.timestamp instanceof Date);

  const tool = toolResultMessage(
    { toolCallId: "call-1", toolName: "run_bash", output: "ok", files: ["a.txt"] },
    4,
  );
  assert.equal(tool.role, "tool");
  assert.equal(tool.toolCallId, "call-1");
  assert.equal(tool.toolName, "run_bash");
  assert.equal(tool.content, "ok");
  assert.deepEqual(tool.files, ["a.txt"]);
  assert.equal(tool.turnIndex, 4);

  const note = systemNoteMessage("shell_status_1", "shells", 5);
  assert.equal(note.role, "system");
  assert.equal(note.isSummary, false);
  assert.equal(note.id, "shell_status_1");
});

test("assistantMessage normalizes empty fields to the persisted shape", () => {
  const silent = assistantMessage({ content: "", reasoning: "", toolCalls: [] }, 1);
  assert.equal(silent.role, "assistant");
  assert.equal(silent.content, null, "empty content persists as null, not ''");
  assert.equal(silent.reasoning, undefined);
  assert.equal(silent.toolCalls, undefined);

  const speaking = assistantMessage(
    {
      content: "hello",
      reasoning: "why",
      toolCalls: [{ id: "c1", name: "run_bash", arguments: "{}" } as never],
    },
    2,
  );
  assert.equal(speaking.content, "hello");
  assert.equal(speaking.reasoning, "why");
  assert.equal(speaking.toolCalls?.length, 1);
});
