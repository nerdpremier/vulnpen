import type { FinishReason, StreamDelta, ToolCallData } from "./types";

// ─── Stream collector ────────────────────────────────────────────────────
// One owner for the state every provider stream accumulates: text and
// reasoning parts, tool-call arguments arriving in chunks, and the closing
// protocol — one `tool_call_done` per call (in start order), the
// "tool calls imply finishReason=tool_calls" promotion, and the
// `join("") || null` result assembly. Before this seam the same machinery was
// written out once per provider pipeline (Anthropic native, OpenAI Responses,
// chat completions), with the invariant enforced by copy-paste and the
// done-delta ordering the agent loop's SSE relay depends on held only by
// convention.

interface ToolCallAccumulator {
  id: string;
  name: string;
  argParts: string[];
  /** Sequential index assigned at start, used in every emitted event. */
  index: number;
}

export interface StreamCollector {
  /** Append model text; emits a `text` delta. Nullish/empty text is ignored. */
  onText(text: string | null | undefined): void;
  /** Append reasoning text; emits a `reasoning` delta. Nullish/empty text is ignored. */
  onReasoning(text: string | null | undefined): void;
  /**
   * Register a tool call under `key` (the provider's own id for the call —
   * Anthropic block index, Responses item id, chat-completions chunk index).
   * Assigns its sequential index and emits `tool_call_start`. Re-registering
   * a key resets its arguments and emits a fresh start.
   */
  startToolCall(key: string, id: string | undefined, name: string | undefined): void;
  /** Whether a tool call was started under this key. */
  hasToolCall(key: string): boolean;
  /** Append argument-text chunk; emits a `tool_call_delta`. Empty text is ignored. */
  appendToolCallArgs(key: string, args: string): void;
  /** Responses `arguments.done`: replace the accumulated text; undefined keeps it. */
  replaceToolCallArgs(key: string, args: string | undefined): void;
  /** Chat-completions chunks: late id/name patches (truthy values only). */
  updateToolCall(key: string, patch: { id?: string; name?: string }): void;
  /** Record a finish reason observed on the stream (caller-owned transitions). */
  setFinishReason(reason: FinishReason): void;
  /**
   * Close the stream: emit one `tool_call_done` per started call in start
   * order, promote stop→tool_calls when calls exist, and return the assembled
   * result fields (empty content and reasoning come back as null).
   */
  finish(): {
    content: string | null;
    reasoning: string | null;
    toolCalls: ToolCallData[];
    finishReason: FinishReason;
  };
}

export function createStreamCollector(
  onDelta: (delta: StreamDelta) => void,
): StreamCollector {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<string, ToolCallAccumulator>();
  let nextIndex = 0;
  let finishReason: FinishReason = "stop";

  const emit = (delta: StreamDelta) => onDelta(delta);

  return {
    onText(text) {
      if (!text) return;
      contentParts.push(text);
      emit({ type: "text", content: text });
    },

    onReasoning(text) {
      if (!text) return;
      reasoningParts.push(text);
      emit({ type: "reasoning", content: text });
    },

    startToolCall(key, id, name) {
      const index = nextIndex++;
      toolCalls.set(key, { id: id ?? "", name: name ?? "", argParts: [], index });
      emit({ type: "tool_call_start", toolCall: { index, id, name } });
    },

    hasToolCall(key) {
      return toolCalls.has(key);
    },

    appendToolCallArgs(key, args) {
      const acc = toolCalls.get(key);
      if (!acc || !args) return;
      acc.argParts.push(args);
      emit({ type: "tool_call_delta", toolCall: { index: acc.index }, content: args });
    },

    replaceToolCallArgs(key, args) {
      const acc = toolCalls.get(key);
      if (acc && args !== undefined) {
        acc.argParts = [args];
      }
    },

    updateToolCall(key, patch) {
      const acc = toolCalls.get(key);
      if (!acc) return;
      if (patch.id) acc.id = patch.id;
      if (patch.name) acc.name = patch.name;
    },

    setFinishReason(reason) {
      finishReason = reason;
    },

    finish() {
      const calls: ToolCallData[] = [];
      for (const acc of toolCalls.values()) {
        const tc: ToolCallData = {
          id: acc.id,
          name: acc.name,
          arguments: acc.argParts.join(""),
        };
        calls.push(tc);
        emit({ type: "tool_call_done", toolCall: { index: acc.index, ...tc } });
      }

      if (calls.length > 0 && finishReason === "stop") {
        finishReason = "tool_calls";
      }

      return {
        content: contentParts.join("") || null,
        reasoning: reasoningParts.join("") || null,
        toolCalls: calls,
        finishReason,
      };
    },
  };
}
