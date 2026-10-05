import type { SSEWriter, SseEventMap } from "../utils/sse";

// ─── Slash reply ─────────────────────────────────────────────────────────
// One owner for the slash-command reply protocol: every command terminates
// with `slash_command_result` → `done` → `end()`, in that order. Before this
// seam the triple was written out by hand at every return path across the
// handlers — forget one `end()` and the HTTP stream hangs open. Handlers
// receive a reply instead of a raw SSEWriter, and the command name is
// stamped once at construction.

/** The streaming close-out of a command started with `stream`. */
export interface SlashStream {
  id: string;
  /** One streamed content chunk for the in-flight result. */
  emit(content: string): void;
  /** The final content, then `done` → `end()`. Nothing may write after this. */
  complete(content: string): void;
}

export interface SlashReply {
  /** Terminal success reply; `extra.action` carries a UI side effect. */
  ok(content: string, extra?: { action?: string }): void;
  /** Terminal failure reply. */
  fail(content: string): void;
  /** The standard "session not found" guard reply. */
  sessionMissing(): void;
  /** Long-running commands announce themselves before computing. */
  ack(message: string): void;
  /**
   * Open an LLM-streaming reply: ack, then `slash_command_result` with
   * `streaming: true`, per-chunk `emit`, and `complete` as the only close.
   */
  stream(ackMessage: string): SlashStream;
}

export function createSlashReply(sse: SSEWriter, command: string): SlashReply {
  const result = (
    payload: Omit<SseEventMap["slash_command_result"], "command">,
  ): void => {
    sse.write("slash_command_result", { command, ...payload });
  };
  const close = (): void => {
    sse.write("done", { message: "Slash command completed" });
    sse.end();
  };
  const fail = (content: string): void => {
    result({ success: false, content });
    close();
  };
  const ack = (message: string): void => {
    sse.write("slash_command_ack", { command, message });
  };

  return {
    ok(content, extra) {
      result({ success: true, content, ...extra });
      close();
    },
    fail,
    sessionMissing: () => fail("Session not found."),
    ack,
    stream(ackMessage) {
      ack(ackMessage);
      const id = `slash_result_${Date.now()}`;
      result({ success: true, content: "", streaming: true, id });
      return {
        id,
        emit: (content) => sse.write("slash_command_stream", { command, id, content }),
        complete: (content) => {
          sse.write("slash_command_done", { command, id, content });
          close();
        },
      };
    },
  };
}
