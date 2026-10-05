import { Response } from "express";

/**
 * The one SSE interface every streaming surface speaks (agent loop,
 * slash commands, controllers). Kept out of agent.service.ts so callers
 * depend on a two-method interface, not on the 995-line agent module.
 */
export interface SSEWriter {
  write: (event: string, data: any) => void;
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
    write(event: string, data: any) {
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
    write(event: string, data: any) {
      if (event === "error") {
        console.error(`[agent:detached:${label}] ${data?.message ?? JSON.stringify(data)}`);
      }
    },
    end() {},
  };
}
