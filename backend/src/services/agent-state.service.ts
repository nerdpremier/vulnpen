import { RedisClientType } from "redis";
import SessionsModel, { AgentState } from "../models/Sessions/Sessions.model";

// Agent runtime state lives outside the request cycle: a Redis pause flag the
// run loop polls, and the persisted run state on the session document. The
// Redis client is registered by the server bootstrap rather than imported from
// it, so this module (and everything that depends on it) stays testable and
// free of HTTP-layer imports.
let redisClient: RedisClientType | undefined;

export function setAgentStateStore(client: RedisClientType): void {
  redisClient = client;
}

const PAUSE_CHECK_KEY = (id: string) => `agent:pause:${id}`;

export async function isPaused(sessionId: string): Promise<boolean> {
  if (!redisClient) return false;
  try {
    const val = await redisClient.GET(PAUSE_CHECK_KEY(sessionId));
    return val === "1";
  } catch {
    return false;
  }
}

export async function setPaused(sessionId: string, paused: boolean): Promise<void> {
  if (!redisClient) return;
  if (paused) {
    await redisClient.SET(PAUSE_CHECK_KEY(sessionId), "1");
  } else {
    await redisClient.DEL(PAUSE_CHECK_KEY(sessionId));
  }
}

export async function setAgentState(sessionId: string, state: AgentState): Promise<void> {
  await SessionsModel.updateOne({ sessionId }, { $set: { agentState: state } });
}
