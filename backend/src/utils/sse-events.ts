import type { consentRequiredEvent } from "../services/consent-batch";
import type { InstallSuggestion } from "../tools/types";

/**
 * The one catalog of SSE events the backend emits and the frontend stream
 * hook (useAgentStream) consumes. Each key is an event name, each value its
 * payload shape. `SSEWriter.write` is typed against this map, so an unknown
 * event name or a hand-built payload fails to compile instead of silently
 * drifting away from what the frontend expects.
 */
export interface SseEventMap {
  /** The user message was persisted; the frontend appends it locally. */
  user_message_ack: { id: string };
  /** Model reasoning delta. */
  reasoning: { content: string };
  /** Model text delta. */
  thinking: { content: string };
  /** A streamed tool call began accumulating arguments. */
  tool_call_start: { index?: number; id?: string; name?: string };
  /** An argument-text delta for the tool call at `index`. */
  tool_call_args: { index?: number; content: string };
  /** A streamed tool call finished and is ready to execute. */
  tool_call_ready: { index?: number; id?: string; name?: string; arguments?: string };
  /** A tool execution started. */
  tool_start: { id: string; name: string; args: Record<string, any> };
  /** A streaming output chunk from a running tool. */
  tool_output: { id: string; chunk: string };
  /** A tool execution finished (truncated output; `outputLength` is pre-truncation). */
  tool_done: { id: string; exitCode?: number; output: string; outputLength: number; files?: string[] };
  /** A tool execution failed before/while running. */
  tool_error: { id: string; error: string };
  /** The run parked on user approval; payload owned by consent-batch. */
  consent_required: ReturnType<typeof consentRequiredEvent>;
  /** The tool suggests installing a missing capability. */
  install_suggestion: InstallSuggestion;
  /** Context compaction started. */
  summarizing: {
    message: string;
    promptTokens?: number;
    budget?: number;
    projectedPromptTokens?: number;
    reason?: string;
  };
  /** Context compaction finished; the summary text for the transcript. */
  summary_done: { summary: string };
  /** Per-LLM-call token accounting. */
  token_usage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    contextLimit: number;
    iteration: number;
    maxIterations: number;
  };
  /** The run hit the configured iteration cap. */
  iteration_limit: { maxIterations: number; message: string };
  /** The run was paused (user pause or abort). */
  paused: { message: string };
  /** The run failed. */
  error: { message: string };
  /** The run finished. Agent turns carry the iteration counters. */
  done: { message: string; iterations?: number; reachedIterationLimit?: boolean };
  /** A slash command was accepted and is producing output. */
  slash_command_ack: { command: string; message: string };
  /** A slash command's final result. */
  slash_command_result: {
    command: string;
    success: boolean;
    content: string;
    /** UI side effect: e.g. "clear_messages", "reset_state". */
    action?: string;
    streaming?: boolean;
    id?: string;
  };
  /** Streaming delta for a slash command result started with `streaming`. */
  slash_command_stream: { command: string; id: string; content: string };
  /** Streaming finished for a slash command result. */
  slash_command_done: { command: string; id: string; content: string };
}

export type SseEventName = keyof SseEventMap & string;
