import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTraceTags } from "../src/utils/traceTags";
import type { AgentMessageDoc } from "../src/models/Sessions/Sessions.model";

function message(partial: Partial<AgentMessageDoc>): AgentMessageDoc {
  return { role: "user", content: "", ...partial } as AgentMessageDoc;
}

test("a transcript with no trailing tool results is tagged planning", () => {
  const { tags, phase } = buildTraceTags("agent", [
    message({ role: "assistant", content: "thinking" }),
  ]);
  assert.deepEqual(tags, ["agent", "planning"]);
  assert.equal(phase, "plan");
});

test("trailing tool results tag the analysis with the tools involved", () => {
  const { tags, phase } = buildTraceTags("agent", [
    message({ role: "user" }),
    message({ role: "assistant" }),
    message({ role: "tool", toolName: "run_bash" }),
    message({ role: "tool", toolName: "run_bash" }),
    message({ role: "tool", toolName: "write_to_shell" }),
  ]);
  // The trailing window is walked backwards, so first-seen order is newest tool first.
  assert.deepEqual(tags, ["agent", "analyze", "write_to_shell", "run_bash"]);
  assert.equal(phase, "analyze");
});

test("extra tags ride along in order and duplicates collapse", () => {
  const { tags } = buildTraceTags(
    "agent",
    [message({ role: "tool", toolName: "run_bash" })],
    ["session_id:s1", "session_id:s1"],
  );
  assert.deepEqual(tags, ["agent", "session_id:s1", "session_id:s1", "analyze", "run_bash"]);
});

test("a tool result interrupted by another role stops the trailing window", () => {
  const { tags, phase } = buildTraceTags("agent", [
    message({ role: "tool", toolName: "run_bash" }),
    message({ role: "assistant", content: "interpreted" }),
  ]);
  assert.equal(phase, "plan");
  assert.equal(tags.includes("run_bash"), false);
});
