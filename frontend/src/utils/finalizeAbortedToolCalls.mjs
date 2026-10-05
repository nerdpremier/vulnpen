// Tool messages that are still streaming when the stream is torn down would
// otherwise stay `streaming: true` forever: `tool_done` / `tool_error` never
// arrive, so nothing ever re-renders them as finished.
//
// The visible symptom was the Browser Agent panel staying unfolded after Stop:
// the panel derives from whether a browser tool message is still streaming, so
// a message stuck on `streaming: true` kept it open.
//
// Kept in its own module so the rule is testable without React.

/** Marker appended to the output of a tool the operator stopped mid-run. */
export const ABORTED_TOOL_MARKER = "[stopped by user]";

/**
 * Returns a message list where every still-streaming tool is marked finished.
 *
 * Only `role === "tool"` messages that are actually streaming are touched, so
 * the assistant message, completed tools and any already-finalised tool keep
 * their object identity and React can skip the needless re-render.
 *
 * No exit code is recorded on purpose: a stopped run did not fail, and
 * ToolCallBlock would otherwise paint a misleading "Exit 1" badge over output
 * the operator interrupted themselves.
 *
 * @param {unknown} messages
 * @returns {unknown} a new array when something changed, otherwise the input
 */
export function finalizeAbortedToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (message?.role !== "tool" || message.streaming !== true) return message;
    changed = true;
    const previous = typeof message.content === "string" ? message.content : "";
    return {
      ...message,
      streaming: false,
      content: `${previous ? `${previous}\n` : ""}${ABORTED_TOOL_MARKER}`,
    };
  });

  return changed ? next : messages;
}