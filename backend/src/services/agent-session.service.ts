/**
 * Data shapes exchanged between the agent runtime, the Redis session store
 * and the session history archive.
 */

export interface HistoryData {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  isContextual?: boolean;
  loopStep?: number;
}

export interface ContextData {
  summary: string;
  nextSteps: string;
}

export interface SingleCommandData {
  tool_name: string;
  args: Record<string, string>;
  file_name?: string[];
  active: boolean;
  loop?: number;
}

export interface AgentSessionData {
  uid: string;
  sessionId: string;
  history: HistoryData[];
  context?: ContextData;
  command?: any;
  subprocess?: any;
  isMainThread: number;
  mainSessionId?: string;
  [key: string]: any;
}

export { runCommandOnKali } from "./ssh.service";
