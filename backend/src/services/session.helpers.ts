import SessionsModel from "../models/Sessions/Sessions.model";
import { Response } from "express";

// ─── Cleared-session mark ────────────────────────────────────────────────
// A cleared session's document was just wiped, so a run that was mid-flight
// when the wipe happened must not append its pre-clear tail back into it.
// This mark is the one fact flush decisions consult: pause and stop (plain
// aborts) do NOT suppress flushing — only a clear does. Lives next to
// resetSessionContext because every clear path (endpoint and slash command)
// wipes through it.

const CLEAR_MARK_TTL_MS = 60 * 60 * 1000; // runs last minutes; an hour is generous
const clearedMarks = new Map<string, number>();

export function markSessionCleared(sessionId: string): void {
  const now = Date.now();
  for (const [id, ts] of clearedMarks) {
    if (now - ts > CLEAR_MARK_TTL_MS) clearedMarks.delete(id);
  }
  clearedMarks.set(sessionId, now);
}

/** Whether the session was cleared at or after `since` (a run's start time). */
export function wasSessionClearedSince(sessionId: string, since: number): boolean {
  const ts = clearedMarks.get(sessionId);
  return ts !== undefined && ts >= since;
}

export async function getActiveSession(userId: string, sessionId: string) {
  return SessionsModel.findOne({
    sessionId,
    uid: userId,
    status: "active",
  });
}

export async function requireActiveSession(
  userId: string,
  sessionId: string,
  res: Response
) {
  const session = await getActiveSession(userId, sessionId);
  if (!session) {
    res.status(400).json({ message: "Session not found" });
    return null;
  }
  return session;
}

/**
 * Ownership-only check for handlers that stream or sanitize without needing
 * the full active-session document (e.g. artifact download). Same 400 +
 * null contract as requireActiveSession, one `_id` projection.
 */
export async function requireOwnedSession(
  userId: string,
  sessionId: string,
  res: Response
) {
  const session = await SessionsModel.findOne({ sessionId, uid: userId }).select("_id");
  if (!session) {
    res.status(404).json({ message: "Session not found" });
    return null;
  }
  return session;
}

/**
 * Resets a session's conversation context to a fresh state: messages drop
 * except the original (non-summary) system message, and all run counters go
 * back to zero. The one place that knows the reset payload — both the /clear
 * endpoint and the /clear slash command go through it. Also marks the
 * session cleared, so an in-flight run stops flushing its stale tail.
 */
export async function resetSessionContext(sessionId: string): Promise<void> {
  markSessionCleared(sessionId);

  const session = await SessionsModel.findOne({ sessionId }).select("messages").lean();
  const systemMsg = (session?.messages as any[] | undefined)?.find(
    (m) => m.role === "system" && !m.isSummary
  );

  await SessionsModel.updateOne(
    { sessionId },
    {
      $set: {
        messages: systemMsg ? [systemMsg] : [],
        subagents: [],
        agentState: "idle",
        pendingConsent: null,
        turnIndex: 0,
        totalTokens: 0,
        tokenHistory: [],
      },
    },
  );
}
