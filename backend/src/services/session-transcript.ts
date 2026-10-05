import { v4 as uuidv4 } from "uuid";
import SessionsModel, { AgentMessageDoc, SessionDoc } from "../models/Sessions/Sessions.model";
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

/**
 * Open a turn: the user's message enters the transcript and turnIndex
 * advances as one save — the counter and the message list always agree.
 * `ensureSystemMessage` seeds a fresh session with its system prompt in the
 * same write.
 */
export async function beginTurn(
  session: SessionDoc,
  text: string,
  opts: { ensureSystemMessage?: () => Promise<AgentMessageDoc> } = {},
): Promise<AgentMessageDoc> {
  if (session.messages.length === 0 && opts.ensureSystemMessage) {
    session.messages.push(await opts.ensureSystemMessage());
  }
  const userMsg = userMessage(text, session.turnIndex);
  session.messages.push(userMsg);
  session.turnIndex += 1;
  await session.save();
  return userMsg;
}

/**
 * Whether the session's transcript records a call to any of these tools.
 * The projection and the two message shapes (toolName on tool results,
 * toolCalls on assistant messages) live here, so an evidence check never
 * re-invents the transcript query.
 */
export async function sessionUsedTool(
  sessionId: string,
  toolNames: readonly string[],
): Promise<boolean> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("messages.toolName messages.toolCalls.name")
    .lean();
  const messages = (session?.messages ?? []) as any[];
  return messages.some(
    (m) =>
      toolNames.includes(m?.toolName) ||
      (Array.isArray(m?.toolCalls) &&
        m.toolCalls.some((t: any) => toolNames.includes(t?.name))),
  );
}

// ─── Run buffer ────────────────────────────────────────────────────────
// One owner for the run's unflushed tail: the messages an agent run has
// produced that have not yet reached Mongo. Before this seam the loop kept a
// parallel `newMessages` array that every producer had to remember to push
// into alongside the transcript (missing one compiles fine and silently
// breaks either the model's view or the DB flush), and the flush protocol —
// "append at every iteration boundary and turn-ending exit, but never
// re-pollute a session that clearContext just wiped" — was copied across five
// sites with hand-written abort guards.

export interface RunBuffer {
  /** The working transcript: what the model sees for the rest of this run. */
  readonly transcript: AgentMessageDoc[];
  /**
   * Add messages to the transcript AND the unflushed tail — one call, both
   * lists. The only way a run appends to the transcript.
   */
  add(...messages: AgentMessageDoc[]): void;
  /**
   * Swap in the post-compaction transcript and drop the tail: its messages
   * were folded into the summary and are gone from the transcript.
   */
  replaceTranscript(messages: AgentMessageDoc[]): void;
  /** Append the tail to Mongo and clear it. No-op when the tail is empty. */
  flush(): Promise<void>;
  /**
   * flush(), but skipped while the run is aborting: clearContext wipes the
   * session document, and stale pre-clear messages must not be re-appended
   * into the cleared session. Used at iteration boundaries and on the error
   * path; turn-ending exits (consent park, circuit open, normal end) flush
   * unconditionally with flush().
   */
  flushIfLive(): Promise<void>;
}

export function createRunBuffer(
  sessionId: string,
  initialTranscript: AgentMessageDoc[],
  isLive: () => boolean,
): RunBuffer {
  let transcript = initialTranscript;
  let tail: AgentMessageDoc[] = [];

  const flush = async (): Promise<void> => {
    await appendMessages(sessionId, tail);
    tail = [];
  };

  return {
    get transcript() {
      return transcript;
    },
    add(...messages) {
      transcript.push(...messages);
      tail.push(...messages);
    },
    replaceTranscript(messages) {
      transcript = messages;
      tail = [];
    },
    flush,
    async flushIfLive() {
      if (tail.length > 0 && isLive()) await flush();
    },
  };
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
