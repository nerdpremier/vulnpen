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
 * of why a detached run died.
 */
export function createDetachedSSEWriter(label: string): SSEWriter {
  return {
    write(event: SseEventName, data: SseEventMap[SseEventName]) {
      if (event === "error") {
        console.error(`[agent:detached:${label}] ${(data as { message?: string })?.message ?? JSON.stringify(data)}`);
      }
    },
    end() {},
  };
}
