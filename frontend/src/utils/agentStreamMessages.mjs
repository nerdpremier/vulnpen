// Pure message-list transforms for the agent stream. These used to live
// inline inside useAgentStream.js; extracted so they are unit-testable
// without mounting React or a store. The hook keeps only timing (rAF /
// interval) and store wiring.

// Cap live tool output held in client state. A chatty scan streams far more
// stdout than the UI ever shows (the block renders the tail only), and keeping
// every byte makes each later render - and the GC - pay for invisible text.
export const MAX_LIVE_TOOL_CHARS = 60_000;

export function mergeToolChunk(existing, chunk) {
  const combined = existing + chunk;
  return combined.length > MAX_LIVE_TOOL_CHARS
    ? "[... earlier output trimmed ...]\n" + combined.slice(-MAX_LIVE_TOOL_CHARS)
    : combined;
}

/** One pass over the message list for a whole buffered-output flush. */
export function applyToolOutputBuffer(messages, buffer) {
  let changed = false;
  const next = messages.map((m) => {
    const chunk = buffer[m.id];
    if (!chunk) return m;
    changed = true;
    return { ...m, content: mergeToolChunk(m.content, chunk) };
  });
  return changed ? next : messages;
}

/** Shallow-patch one message by id; others are returned as-is. */
export function patchMessage(messages, id, patch) {
  return messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

export function applyToolDone(messages, data) {
  return messages.map((m) => {
    if (m.id !== `tool_${data.id}`) return m;
    const useServerOutput = data.output && (!m.content || m.content.length === 0);
    return {
      ...m,
      content: useServerOutput ? data.output : m.content,
      streaming: false,
      exitCode: data.exitCode,
      files: data.files ?? m.files,
    };
  });
}

export function applyToolError(messages, data) {
  return patchMessage(messages, `tool_${data.id}`, {
    content: data.error,
    streaming: false,
    exitCode: 1,
  });
}

/** Land the final streamed content/reasoning/toolCalls and clear the flags. */
export function finalizeStreamedAssistant(messages, ref) {
  const existing = messages.find((m) => m.id === ref.id);
  if (!existing) return messages;
  return messages.map((m) =>
    m.id === ref.id
      ? {
          ...m,
          content: ref.content,
          reasoning: ref.reasoning || undefined,
          toolCalls: [...ref.toolCalls],
          streaming: false,
          reasoningStreaming: false,
        }
      : m,
  );
}
