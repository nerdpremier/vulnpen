import type OpenAI from "openai";

// ─── Shared invocation types ─────────────────────────────────────────
// The vocabulary every llm module and every caller speaks: the provider
// config, the invoke options/results, and the stream delta. Pure types —
// no behavior, no dependencies beyond the OpenAI type namespace, so the
// config, invoke, and streaming modules can all lean on it without
// importing each other.

export type ProviderType =
  | "openai"
  | "anthropic"
  | "anthropic-compatible"
  | "openrouter"
  | "ollama"
  | "openai-compatible"
  | "google"
  | "mistralai"
  | "kimi"
  | "minimax"
  | "bedrock"
  | "codex-subscription"
  | "claude-subscription";

export interface ProviderConfig {
  provider: ProviderType;
  apiKey: string;
  model: string;
  baseURL?: string;
  authMethod?: "api_key" | "oauth" | "subscription";
  oauthAccessToken?: string;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: string;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error";

export type ReasoningMode =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface InvokeOptions {
  messages: Array<OpenAI.Chat.ChatCompletionMessageParam>;
  tools?: OpenAI.Chat.ChatCompletionTool[];
  format?: "json" | "text";
  temperature?: number;
  reasoningMode?: ReasoningMode;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  generationName?: string;
  providerOverride?: ProviderConfig;
}

export interface InvokeResult {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCallData[];
  finishReason: FinishReason;
  usage: OpenAI.Completions.CompletionUsage | undefined;
  model: string;
  provider: ProviderType;
  elapsedMs: number;
}

export interface StreamDelta {
  type:
    | "text"
    | "reasoning"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_done";
  content?: string;
  toolCall?: Partial<ToolCallData> & { index?: number };
}

export interface StreamingInvokeOptions extends InvokeOptions {
  onDelta: (delta: StreamDelta) => void;
  abortSignal?: AbortSignal;
}
