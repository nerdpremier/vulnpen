import OpenAI from "openai";
import { invoke_llm } from "../utils/llm/providers";
import { getProvider } from "../utils/llm/providers";
import { AgentMessageDoc } from "../models/Sessions/Sessions.model";
import { EngagementState } from "./engagement-state";
import { getModelContextLimit } from "../utils/modelMetadata";

// Summarize well below half the context window, not 70%: prompt tokens are
// paid every inference call, so a history that idles near the threshold is the
// single biggest cost driver (a measured run idled at ~88k prompt tokens for
// hundreds of turns).
const SUMMARIZE_THRESHOLD = 0.40;
// Cap the working set by absolute cost, not only by context window: on
// million-token models the window threshold (40% = 400k) never fires, so the
// history idled at ~45k prompt tokens and was re-sent on every one of hundreds
// of tool-loop calls (an 8.1M-token session traced back to exactly this).
// The budget is checked against the FULL prompt (lastPromptTokens), which
// includes the system message (~4.7k tokens) and the core tool schemas (~4k).
// 14k therefore leaves roughly 5k of history: summary + recent window fit
// inside that (summary ~1k, recent tool results capped at 2.5k chars each), so
// summarisation does not thrash. The stable prefix is prompt-cached on
// Anthropic providers, so the marginal cost per call is dominated by the
// fresh tail. Do not lower further without shrinking PRESERVE_RECENT_MESSAGES
// and the tool-result caps to match, or summarisation will thrash.
const WORKING_SET_TOKEN_BUDGET = 14_000;
const CHARS_PER_TOKEN_ESTIMATE = 3.5;
const PRESERVE_RECENT_MESSAGES = 6;
// Tool results older than this many messages are collapsed to a stub: the
// summary and the engagement state already carry what mattered, and re-sending
// full scan output for hundreds of turns was pure token burn.
const RECENT_FULL_TOOL_RESULTS = 8;
const STALE_TOOL_RESULT_CHARS = 250;
// Old tool-call ARGUMENTS are stubbed too: re-sending a 5k-char nmap command
// or a full add_vulnerability payload hundreds of turns later is pure burn.
// The result stub and the summary carry the outcome.
const STALE_TOOL_CALL_ARGS_CHARS = 200;
// Even fresh (recent-window) tool results get a ceiling: one oversized scan
// dump inside the recent window can blow the whole working-set budget on its
// own. Past this size the head+tail keep the opening status and final summary;
// the agent can re-run the tool with narrower output if the middle mattered.
const RECENT_TOOL_RESULT_MAX_CHARS = 2_500;

function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function estimateMessagesTokens(messages: Array<{ role: string; content: string | null }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // role + structural overhead
    total += estimateTokens(msg.content);
  }
  return total;
}

export async function shouldSummarize(
  messages: AgentMessageDoc[],
  lastPromptTokens?: number,
): Promise<boolean> {
  const config = await getProvider();
  const limit = getModelContextLimit(config.model);
  const inputTokens = lastPromptTokens ?? estimateMessagesTokens(
    messages.map((m) => ({ role: m.role, content: m.content })),
  );
  const threshold = Math.min(limit * SUMMARIZE_THRESHOLD, WORKING_SET_TOKEN_BUDGET);
  return inputTokens > threshold;
}

const FALLBACK_SUMMARIZE_PROMPT = `You are a penetration test engagement summarizer. Your job is to compress a conversation history into a dense summary that preserves all important context for continuing the engagement.

Include in your summary:
- Target IP(s), hostnames, and network details
- All open ports and services discovered (with versions)
- Tools used and their key findings
- Vulnerabilities identified (with severity assessment)
- Credentials, tokens, or secrets discovered
- Files created or downloaded
- Current attack surface understanding
- What has been attempted and the results
- Promising attack vectors not yet explored
- Active persistent shells and their purposes (shell IDs, labels, what is running in them)

Be comprehensive. This summary replaces the full conversation history.`;

function buildSummarizePrompt(state?: EngagementState): string {
  if (state && !state.isEmpty()) {
    return `You are summarizing an agent conversation. A structured engagement state is maintained separately and will be preserved across this summarization. Focus your summary on:
- Reasoning, hypotheses, and analysis NOT captured in the structured state
- Context about WHY certain approaches were tried
- Observations that don't fit structured categories
- Current thinking direction and open questions
- Active shells and their purposes

Do NOT re-list hosts, ports, credentials, vulnerabilities, flag attempts, or file analyses — those are already tracked in the structured engagement state below:

${state.toPromptBlock()}

Summarize only the reasoning and narrative context around these findings.`;
  }
  return FALLBACK_SUMMARIZE_PROMPT;
}

export async function summarizeMessages(
  messages: AgentMessageDoc[],
  traceContext?: { sessionId?: string; userId?: string },
  engagementState?: EngagementState,
): Promise<{
  summaryMessage: AgentMessageDoc;
  preservedMessages: AgentMessageDoc[];
}> {
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length <= PRESERVE_RECENT_MESSAGES) {
    return {
      summaryMessage: null as any,
      preservedMessages: messages,
    };
  }

  let splitIndex = nonSystemMessages.length - PRESERVE_RECENT_MESSAGES;

  // Walk the split boundary backwards so we never orphan tool-result messages
  // from their preceding assistant+tool_calls message. If the first preserved
  // message is a tool result, pull the boundary back until the matching
  // assistant message (and any sibling tool results) are also preserved.
  while (splitIndex > 0 && nonSystemMessages[splitIndex]?.role === "tool") {
    splitIndex--;
  }

  const toSummarize = nonSystemMessages.slice(0, splitIndex);
  const toPreserve = nonSystemMessages.slice(splitIndex);

  const conversationText = toSummarize
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        const toolDesc = m.toolCalls
          .map((tc) => `[Tool: ${tc.name}](${tc.arguments})`)
          .join(", ");
        return `Assistant: ${m.content ?? ""} ${toolDesc}`;
      }
      if (m.role === "tool") {
        return `Tool Result (${m.toolName ?? "unknown"}): ${m.content?.slice(0, 500) ?? ""}`;
      }
      return `${m.role}: ${m.content ?? ""}`;
    })
    .join("\n\n");

  const summaryResult = await invoke_llm({
    messages: [
      { role: "system", content: buildSummarizePrompt(engagementState) },
      { role: "user", content: conversationText },
    ] as OpenAI.Chat.ChatCompletionMessageParam[],
    temperature: 0.3,
    sessionId: traceContext?.sessionId,
    userId: traceContext?.userId,
    tags: ["agent", "context", "summarize"],
    generationName: "context-summarization",
  });

  const summaryContent = summaryResult.content ?? "Summary generation failed.";

  const summaryMessage: AgentMessageDoc = {
    id: `summary_${Date.now()}`,
    role: "system",
    content: `[Previous conversation summarized]\n\n${summaryContent}`,
    timestamp: new Date(),
    turnIndex: toPreserve[0]?.turnIndex ?? 0,
    isSummary: true,
  };

  const result: AgentMessageDoc[] = [];
  if (systemMsg) result.push(systemMsg);
  result.push(summaryMessage);
  result.push(...toPreserve);

  return {
    summaryMessage,
    preservedMessages: result,
  };
}

export function messagesToOpenAI(
  messages: AgentMessageDoc[],
  includeReasoningContent = false,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const toolResponseIds = new Set(
    messages.filter((m) => m.role === "tool" && m.toolCallId).map((m) => m.toolCallId!),
  );

  // Collect all tool_call IDs present on assistant messages so we can
  // detect orphaned tool-result messages whose assistant was summarized away.
  const assistantToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        assistantToolCallIds.add(tc.id);
      }
    }
  }

  // Reasoning replay (Kimi interleaved thinking): only the recent window's
  // assistant messages keep their reasoning_content. Reasoning is routinely
  // 2-5x the visible text and older reasoning is dead weight — replaying it
  // for the whole history on every tool-loop iteration was 1-5k tokens of
  // pure burn per call.
  const reasoningWindowStart = messages.length - PRESERVE_RECENT_MESSAGES;

  return messages.flatMap((m, index) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const validToolCalls = m.toolCalls.filter((tc) => toolResponseIds.has(tc.id));

      if (validToolCalls.length === 0) {
        const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam & {
          reasoning_content?: string;
        } = {
          role: "assistant" as const,
          content: m.content ?? "",
        };
        if (includeReasoningContent && m.reasoning && index >= reasoningWindowStart) {
          assistantMessage.reasoning_content = m.reasoning;
        }
        return assistantMessage;
      }

      const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam & {
        reasoning_content?: string;
      } = {
        role: "assistant" as const,
        content: m.content,
        tool_calls: validToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments:
              tc.arguments.length > STALE_TOOL_CALL_ARGS_CHARS &&
              index < messages.length - RECENT_FULL_TOOL_RESULTS
                ? tc.arguments.slice(0, Math.floor(STALE_TOOL_CALL_ARGS_CHARS / 2)) +
                  ` ... [older tool-call arguments elided from context] ... ` +
                  tc.arguments.slice(-Math.floor(STALE_TOOL_CALL_ARGS_CHARS / 2))
                : tc.arguments,
          },
        })),
      };
      if (includeReasoningContent && m.reasoning && index >= reasoningWindowStart) {
        assistantMessage.reasoning_content = m.reasoning;
      }
      return assistantMessage;
    }

    if (m.role === "tool") {
      // Drop orphaned tool results whose assistant+tool_calls was removed
      // (e.g. by summarization). Sending these causes 400 errors on the
      // OpenAI Responses API ("No tool call found for function call output").
      if (!m.toolCallId || !assistantToolCallIds.has(m.toolCallId)) {
        return [];
      }
      let content = m.content ?? "";
      // Stale results collapse to head+tail stubs: fresh ones (inside the
      // recent window) go to the model whole so an in-flight scan stays
      // readable while it is still being acted on.
      if (
        content.length > STALE_TOOL_RESULT_CHARS &&
        index < messages.length - RECENT_FULL_TOOL_RESULTS
      ) {
        const head = Math.floor(STALE_TOOL_RESULT_CHARS * 0.5);
        const tail = STALE_TOOL_RESULT_CHARS - head;
        content =
          content.slice(0, head) +
          `\n... [${content.length - STALE_TOOL_RESULT_CHARS} chars of this older tool output elided from context] ...\n` +
          content.slice(-tail);
      } else if (content.length > RECENT_TOOL_RESULT_MAX_CHARS) {
        const head = Math.floor(RECENT_TOOL_RESULT_MAX_CHARS * 0.5);
        const tail = RECENT_TOOL_RESULT_MAX_CHARS - head;
        content =
          content.slice(0, head) +
          `\n... [${content.length - RECENT_TOOL_RESULT_MAX_CHARS} chars of this tool output elided from context] ...\n` +
          content.slice(-tail);
      }
      return {
        role: "tool" as const,
        content,
        tool_call_id: m.toolCallId,
      };
    }

    const message = {
      role: m.role as "system" | "user" | "assistant",
      content: m.content ?? "",
    };
    if (includeReasoningContent && m.role === "assistant" && m.reasoning && index >= reasoningWindowStart) {
      return { ...message, reasoning_content: m.reasoning };
    }
    return message;
  });
}
