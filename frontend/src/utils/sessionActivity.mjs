/**
 * Session activity — the pure projection behind the chat page's readout:
 * how many tool calls the session made, how many landed, which tools carried
 * the work and how long the engagement has been running. Pure so the math is
 * testable without React; ChatView only renders what this returns.
 */

/** A session's wall-clock span, rounded to the unit a human reads. */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How a tool call landed, keyed off its indexed output. */
export function toolCallState(output) {
  // A call with no result yet is still in flight, not a failure: the
  // stream writes the tool message when the tool returns.
  if (!output || output.streaming) return "running";
  if (output.exitCode == null) return "settled";
  return output.exitCode === 0 ? "succeeded" : "failed";
}

/**
 * Summarise the transcript for the activity strip: totals per outcome, the
 * top tool rows (most calls first, ties alphabetical) and the wall-clock span.
 */
export function summariseSessionActivity(messages, toolIndex) {
  const calls = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) calls.push(call);
    }
  }

  let succeeded = 0;
  let failed = 0;
  let running = 0;
  const perTool = new Map();

  for (const call of calls) {
    const output = toolIndex.outputs.get(call.id);
    const state = toolCallState(output);

    if (state === "failed") failed += 1;
    else if (state === "succeeded") succeeded += 1;
    else if (state === "running") running += 1;

    const name = call.name || "tool";
    const row = perTool.get(name) ?? { key: name, label: name, value: 0, failed: 0 };
    row.value += 1;
    if (state === "failed") row.failed += 1;
    perTool.set(name, row);
  }

  const stamps = messages
    .map((message) => new Date(message.timestamp).getTime())
    .filter((value) => Number.isFinite(value));
  const elapsedMs = stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : null;

  const tools = [...perTool.values()]
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, 4)
    .map((row) => ({
      key: row.key,
      label: row.label,
      value: row.value,
      tone: row.failed ? "danger" : "success",
      hint: `${row.label}: ${row.value} call${row.value === 1 ? "" : "s"}${
        row.failed ? ` · ${row.failed} failed` : ""
      }`,
    }));

  return {
    calls: calls.length,
    succeeded,
    failed,
    running,
    tools,
    elapsedMs,
  };
}
