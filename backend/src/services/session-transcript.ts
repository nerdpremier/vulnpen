import { v4 as uuidv4 } from "uuid";
import SessionsModel, { AgentMessageDoc } from "../models/Sessions/Sessions.model";
import type { ToolCallData } from "../utils/llm/providers";

// ─── Transcript ──────────────────────────────────────────────────────────
// One owner for the session document's transcript: how a message of each
// role is constructed (id, timestamp, turnIndex — the fields every literal
// used to have to remember), how it reaches Mongo (append / replace /
// token bookkeeping), and the run-state reset invariant. Before this seam
// the message shape was hand-built at four call sites and the
// "agentState + pendingConsent reset together" rule lived in its callers.

// ─── Message constructors ──────────────────────────────────────────────

export function userMessage(content: string, turnIndex: number): AgentMessageDoc {
  return {
    id: uuidv4(),
    role: "user",
    content,
    timestamp: new Date(),
    turnIndex,
  };
}

export function assistantMessage(
  params: {
    content?: string | null;
    reasoning?: string;
    toolCalls?: ToolCallData[];
  },
  turnIndex: number,
): AgentMessageDoc {
  const { content, reasoning, toolCalls } = params;
  return {
    id: uuidv4(),
    role: "assistant",
    content: content || null,
    reasoning: reasoning || undefined,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    timestamp: new Date(),
    turnIndex,
  };
}

/** A tool outcome recorded in the transcript: executed, refused or denied. */
export function toolResultMessage(
  params: {
    toolCallId: string;
    toolName: string;
    output: string;
    files?: string[];
  },
  turnIndex: number,
): AgentMessageDoc {
  return {
    id: uuidv4(),
    role: "tool",
    content: params.output,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    files: params.files,
    timestamp: new Date(),
    turnIndex,
  };
}

/** A note addressed to the model rather than produced by a speaker. */
export function systemNoteMessage(
  id: string,
  content: string,
  turnIndex: number,
): AgentMessageDoc {
  return {
    id,
    role: "system",
    content,
    timestamp: new Date(),
    turnIndex,
    isSummary: false,
  };
}

// ─── Persistence ───────────────────────────────────────────────────────

export async function appendMessages(sessionId: string, messages: AgentMessageDoc[]): Promise<void> {
  if (!messages.length) return;
  await SessionsModel.updateOne(
    { sessionId },
    { $push: { messages: { $each: messages } } },
  );
}

export async function replaceMessages(sessionId: string, messages: AgentMessageDoc[]): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    { $set: { messages } },
  );
}

export async function trackTokens(
  sessionId: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    {
      $inc: { totalTokens },
      $push: {
        tokenHistory: {
          promptTokens,
          completionTokens,
          totalTokens,
          timestamp: new Date(),
        },
      },
    },
  );
}

// ─── Run-state reset ───────────────────────────────────────────────────

/**
 * Reset the run state to idle: agentState and pendingConsent go back
 * together — a parked consent batch without a running agent is exactly the
 * stuck state /reset exists to clear. The one place that knows this pairing.
 */
export async function resetAgentRun(sessionId: string): Promise<void> {
  await SessionsModel.updateOne(
    { sessionId },
    {
      $set: {
        agentState: "idle",
        pendingConsent: null,
      },
    },
  );
}
