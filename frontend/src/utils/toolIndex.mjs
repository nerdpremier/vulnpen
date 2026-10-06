/**
 * Index a message list once so tool results render inline inside their parent
 * assistant block, and assistant toolCalls can find their streamed output.
 * Shared by the chat view and the per-run activity stream on the case page.
 */
export function buildToolIndex(messages) {
  const outputs = new Map();
  const callIds = new Set();
  const args = new Map();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        callIds.add(tc.id);
        if (tc.arguments != null) args.set(tc.id, tc.arguments);
      }
    } else if (m.role === "tool" && m.toolCallId) {
      outputs.set(m.toolCallId, m);
    }
  }
  const visibleMessages = messages.filter(
    (m) => m.role !== "tool" || !callIds.has(m.toolCallId),
  );
  return { toolIndex: { outputs, callIds, args }, visibleMessages };
}
