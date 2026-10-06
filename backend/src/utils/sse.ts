import { Response } from "express";
import type { SseEventMap, SseEventName } from "./sse-events";

export type { SseEventMap, SseEventName };

/**
 * The one SSE interface every streaming surface speaks (agent loop,
 * slash commands, controllers). Kept out of agent.service.ts so callers
 * depend on a two-method interface, not on the 900-line agent module. The
 * event vocabulary is typed: `write` only accepts names and payloads from
 * the SseEventMap catalog in sse-events.ts.
 */
export interface SSEWriter {
  write: <E extends SseEventName>(event: E, data: SseEventMap[E]) => void;
  end: () => void;
}

export function createSSEWriter(res: Response): SSEWriter {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  return {
    write(event: SseEventName, data: unknown) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // client disconnected
      }
    },
    end() {
      try {
        res.end();
      } catch {
        // already ended
      }
    },
  };
}

/**
 * An SSEWriter with no client attached, for agent runs started by the server
 * rather than by a streaming request. The agent loop
 * already persists messages and state to the session document, so the UI picks
 * the run up from session history — these events simply have nowhere to go.
 *
 * `error` events are logged, since with no client there is otherwise no trace
 * of why a detached run died; an optional onError hook lets the caller record
 * the failure (e.g. on the run's own history record).
 */
export function createDetachedSSEWriter(
  label: string,
  onError?: (message: string) => void,
): SSEWriter {
  return {
    write(event: SseEventName, data: SseEventMap[SseEventName]) {
      if (event === "error") {
        const message =
          (data as { message?: string })?.message ?? JSON.stringify(data);
        console.error(`[agent:detached:${label}] ${message}`);
        onError?.(message);
      }
    },
    end() {},
  };
}

// ─── Stream delta forwarding ───────────────────────────────────────────

import type { StreamDelta } from "./llm/types";

/**
 * The standard translation from provider stream deltas to SSE events —
 * the producer side of the catalog in sse-events.ts. The agent loop's
 * onDelta is exactly this: keeping the translation here means a new delta
 * type or payload change is made once, next to the event names it emits.
 */
export function forwardStreamDelta(sse: SSEWriter, delta: StreamDelta): void {
  if (delta.type === "reasoning" && delta.content) {
    sse.write("reasoning", { content: delta.content });
  }
  if (delta.type === "text" && delta.content) {
    sse.write("thinking", { content: delta.content });
  }
  if (delta.type === "tool_call_start" && delta.toolCall) {
    sse.write("tool_call_start", {
      index: delta.toolCall.index,
      id: delta.toolCall.id,
      name: delta.toolCall.name,
    });
  }
  if (delta.type === "tool_call_delta" && delta.content) {
    sse.write("tool_call_args", {
      index: delta.toolCall?.index,
      content: delta.content,
    });
  }
  if (delta.type === "tool_call_done" && delta.toolCall) {
    sse.write("tool_call_ready", {
      index: delta.toolCall.index,
      id: delta.toolCall.id,
      name: delta.toolCall.name,
      arguments: delta.toolCall.arguments,
    });
  }
}
