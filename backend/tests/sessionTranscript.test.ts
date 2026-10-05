import { test } from "node:test";
import assert from "node:assert/strict";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
  systemNoteMessage,
  createRunBuffer,
} from "../src/services/session-transcript";
import SessionsModel from "../src/models/Sessions/Sessions.model";

/** Capture the updateOne writes the transcript module makes, in order. */
function captureWrites(): { writes: { filter: unknown; update: unknown }[] } {
  const writes: { filter: unknown; update: unknown }[] = [];
  (SessionsModel as any).updateOne = async (filter: unknown, update: unknown) => {
    writes.push({ filter, update });
    return {};
  };
  return { writes };
}

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

test("add() feeds the transcript and the tail together; flushIfLive() appends exactly the tail", async () => {
  const { writes } = captureWrites();
  const buffer = createRunBuffer("s1", [{ id: "sys", role: "system" } as never], () => true);

  const assistant = assistantMessage({ content: "working" }, 1);
  const tool = toolResultMessage({ toolCallId: "c1", toolName: "run_bash", output: "ok" }, 1);
  buffer.add(assistant, tool);

  assert.equal(buffer.transcript.length, 3);
  assert.equal(buffer.transcript[1], assistant, "the transcript sees the same message object");

  await buffer.flushIfLive();
  assert.equal(writes.length, 1);
  const pushed = (writes[0].update as { $push: { messages: { $each: unknown[] } } }).$push.messages.$each;
  assert.deepEqual(pushed, [assistant, tool], "the tail carries every added message, in order");

  writes.length = 0;
  await buffer.flushIfLive();
  assert.equal(writes.length, 0, "flush clears the tail — a second flush is a no-op");
});

test("flushIfLive() skips when isLive() says the tail's destination is gone — a cleared session is never re-polluted", async () => {
  const { writes } = captureWrites();
  let live = true;
  const buffer = createRunBuffer("s1", [], () => live);
  buffer.add(assistantMessage({ content: "pre-clear" }, 2));

  live = false;
  await buffer.flushIfLive();
  assert.equal(writes.length, 0, "a run whose session was cleared must not append");

  live = true;
  await buffer.flushIfLive();
  assert.equal(writes.length, 1, "live runs flush at the iteration boundary");
});

test("replaceTranscript() swaps the working transcript and discards the tail", async () => {
  const { writes } = captureWrites();
  const buffer = createRunBuffer("s1", [], () => true);
  buffer.add(assistantMessage({ content: "pre-compaction" }, 1));

  const preserved = [systemNoteMessage("summary", "the summarized context", 1)];
  buffer.replaceTranscript(preserved);
  assert.equal(buffer.transcript.length, 1);
  assert.equal(buffer.transcript[0].id, "summary");

  await buffer.flushIfLive();
  assert.equal(writes.length, 0, "folded-into-summary messages must not be re-appended");
});
