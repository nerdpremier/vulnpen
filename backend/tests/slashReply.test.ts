import { test } from "node:test";
import assert from "node:assert/strict";
import type { SSEWriter, SseEventMap } from "../src/utils/sse";
import { createSlashReply } from "../src/services/slash-reply";

/** Record every event a reply writes, in order — the protocol IS the order. */
function recordingWriter(): { writer: SSEWriter; events: [string, unknown][]; ended: () => boolean } {
  const events: [string, unknown][] = [];
  let end = false;
  return {
    events,
    ended: () => end,
    writer: {
      write(event, data) {
        assert.ok(!end, "nothing may write after end()");
        events.push([event, data]);
      },
      end() {
        end = true;
      },
    },
  };
}

test("ok and fail terminate with result → done → end, command stamped once", () => {
  const { writer, events, ended } = recordingWriter();
  createSlashReply(writer, "clear").ok("Context cleared.", { action: "clear_messages" });

  assert.deepEqual(events.map(([name]) => name), ["slash_command_result", "done"]);
  assert.deepEqual(events[0][1], {
    command: "clear",
    success: true,
    content: "Context cleared.",
    action: "clear_messages",
  });
  assert.ok(ended());

  const failure = recordingWriter();
  createSlashReply(failure.writer, "map").fail("boom");
  assert.deepEqual(failure.events.map(([name]) => name), ["slash_command_result", "done"]);
  assert.equal((failure.events[0][1] as SseEventMap["slash_command_result"]).success, false);
  assert.ok(failure.ended());
});

test("sessionMissing is the shared guard reply", () => {
  const { writer, events } = recordingWriter();
  createSlashReply(writer, "status").sessionMissing();
  const result = events[0][1] as SseEventMap["slash_command_result"];
  assert.equal(result.success, false);
  assert.equal(result.content, "Session not found.");
  assert.equal(result.command, "status");
});

test("stream opens with ack + streaming result, emits chunks, and completes once", () => {
  const { writer, events, ended } = recordingWriter();
  const stream = createSlashReply(writer, "summarize").stream("Generating summary...");

  assert.deepEqual(events.map(([name]) => name), ["slash_command_ack", "slash_command_result"]);
  const opened = events[1][1] as SseEventMap["slash_command_result"];
  assert.equal(opened.streaming, true);
  assert.equal(opened.success, true);
  assert.ok(opened.id);

  stream.emit("part one ");
  stream.emit("part two");
  stream.complete("part one part two");

  assert.deepEqual(events.slice(2).map(([name]) => name), [
    "slash_command_stream",
    "slash_command_stream",
    "slash_command_done",
    "done",
  ]);
  const streamed = events[2][1] as SseEventMap["slash_command_stream"];
  assert.equal(streamed.id, opened.id);
  assert.equal(streamed.content, "part one ");
  const completed = events[4][1] as SseEventMap["slash_command_done"];
  assert.equal(completed.content, "part one part two");
  assert.equal(completed.id, opened.id);
  assert.ok(ended());
});

test("ack announces a long-running command without terminating it", () => {
  const { writer, events, ended } = recordingWriter();
  createSlashReply(writer, "export").ack("Generating report...");
  assert.deepEqual(events.map(([name]) => name), ["slash_command_ack"]);
  assert.equal((events[0][1] as SseEventMap["slash_command_ack"]).message, "Generating report...");
  assert.equal(ended(), false);
});
