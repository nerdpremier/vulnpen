import SessionsModel from "../models/Sessions/Sessions.model";
import { Response } from "express";

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
 * Resets a session's conversation context to a fresh state: messages drop
 * except the original (non-summary) system message, and all run counters go
 * back to zero. The one place that knows the reset payload — both the
 * /clear endpoint and the /clear slash command go through it.
 */
export async function resetSessionContext(sessionId: string): Promise<void> {
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
