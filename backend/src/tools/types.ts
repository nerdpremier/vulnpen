import OpenAI from "openai";
import { ShellInfo, ShellPurpose } from "../services/shell.manager";
import { EngagementState } from "../services/engagement-state";

export interface InstallSuggestion {
  name: string;
  label: string;
  installCommand: string;
  size: string;
}

export interface ToolResult {
  output: string;
  exitCode?: number;
  files?: string[];
  installSuggestion?: InstallSuggestion;
}

export interface ExecutionContext {
  sessionId: string;
  userId?: string;
  agentId: string;
  runCommand: (command: string, timeoutMs?: number) => Promise<{ output: string; exitCode: number }>;
  spawnShell: (label: string, type?: "pty" | "exec", purpose?: ShellPurpose) => Promise<string>;
  writeToShell: (shellId: string, data: string) => Promise<void>;
  readShellOutput: (shellId: string, fromOffset?: number) => Promise<{ data: string; offset: number }>;
  closeShell: (shellId: string) => Promise<void>;
  resizeShell: (shellId: string, cols: number, rows: number) => void;
  listShells: () => ShellInfo[];
  getShellInfo: (shellId: string) => ShellInfo | undefined;
  onOutput?: (chunk: string) => void;
  engagementState?: EngagementState;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  requiresConsent?: boolean;
  timeoutMs?: number;
  /**
   * Whether the tool's external dependency (env settings, assigned model, API
   * key) is configured right now. Returns the user-facing refusal when it is
   * not, undefined when the tool is ready. One source of truth for both the
   * schema filter (unconfigured tools are dropped from the LLM context and
   * greyed out in the UI) and the run path (refuses before execute), so a tool
   * can never be offered to the model without also being callable, and vice
   * versa. Configuration only: per-user authorization stays in execute.
   */
  checkReady?: () => string | undefined | Promise<string | undefined>;
  /**
   * The consent boundary, evaluated in one place. A tool crosses a boundary
   * exactly when this returns a detail — there is no separate boolean; the
   * run path derives `safetyTriggered` from it, so the two can never disagree
   * and the boundary is never computed twice per call.
   */
  describeSafety?: (args: Record<string, any>, ctx: ExecutionContext) => SafetyDetail | undefined;
  execute: (args: Record<string, any>, ctx: ExecutionContext) => Promise<ToolResult>;
}

/** Which boundary stopped the tool: a destructive pattern on the attack box, a
 *  destructive action against the engagement target (the proof-of-concept
 *  boundary), or a target outside the declared engagement scope. The consent
 *  dialog labels them differently, so the reason travels with its kind instead
 *  of being guessed from the text. */
export type SafetyKind = "dangerous" | "destructive_target" | "out_of_scope";

export interface SafetyDetail {
  kind: SafetyKind;
  reason: string;
  impact: string;
}

export function toolToOpenAISchema(tool: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
