import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardStreamDelta } from "../src/utils/sse";
import type { SSEWriter, SseEventMap } from "../src/utils/sse";
import type { StreamDelta } from "../src/utils/llm/providers";

function recordingWriter(): { sse: SSEWriter; events: [string, unknown][] } {
  const events: [string, unknown][] = [];
  return {
    events,
    sse: {
      write: (event, data) => events.push([event, data]),
      end: () => {},
    } as SSEWriter,
  };
}

function delta(partial: any): StreamDelta {
  return partial as StreamDelta;
}

test("reasoning and text deltas map to their SSE events", () => {
  const { sse, events } = recordingWriter();

  forwardStreamDelta(sse, delta({ type: "reasoning", content: "hm" }));
  forwardStreamDelta(sse, delta({ type: "text", content: "hi" }));

  assert.deepEqual(events, [
    ["reasoning", { content: "hm" }],
    ["thinking", { content: "hi" }],
  ]);
});

test("empty content deltas are dropped, not forwarded", () => {
  const { sse, events } = recordingWriter();

  forwardStreamDelta(sse, delta({ type: "text", content: "" }));

  assert.deepEqual(events, []);
});

test("the tool-call lifecycle maps start, args, and ready", () => {
  const { sse, events } = recordingWriter();

  forwardStreamDelta(
    sse,
    delta({ type: "tool_call_start", toolCall: { index: 0, id: "t1", name: "run_bash" } }),
  );
  forwardStreamDelta(sse, delta({ type: "tool_call_delta", toolCall: { index: 0 }, content: '{"cm' }));
  forwardStreamDelta(
    sse,
    delta({
      type: "tool_call_done",
      toolCall: { index: 0, id: "t1", name: "run_bash", arguments: '{"cmd":"ls"}' },
    }),
  );

  assert.deepEqual(events, [
    ["tool_call_start", { index: 0, id: "t1", name: "run_bash" }],
    ["tool_call_args", { index: 0, content: '{"cm' }],
    [
      "tool_call_ready",
      { index: 0, id: "t1", name: "run_bash", arguments: '{"cmd":"ls"}' },
    ],
  ]);
});
