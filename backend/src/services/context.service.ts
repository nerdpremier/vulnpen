import OpenAI from "openai";
import { invoke_llm } from "../utils/llm/providers";
import { getProvider } from "../utils/llm/providers";
import { AgentMessageDoc } from "../models/Sessions/Sessions.model";
import { EngagementState } from "./engagement-state";
import { getModelContextLimit } from "../utils/modelMetadata";

// ─── Budget model ──────────────────────────────────────────────────────────
// The full prompt sent on EVERY tool-loop iteration is
//     system prompt  +  core tool schemas  +  conversation history
// and it is re-sent on every iteration, so it is both the biggest cost driver
// and the thing compaction exists to bound. Two properties keep it cheap:
//   1. the static prefix is prompt-cached by the provider, so the marginal
//      cost is dominated by the fresh tail; and
//   2. the history is summarized before it can idle large.
//
// The failure this file exists to prevent is SUMMARIZATION THRASHING: a long
// (~97-case) run that summarized, ran one or two tools, and summarized again,
// each rewrite throwing away detail the model had just paid to read. Three
// defects caused it; each is now guarded:
//   a. a fixed-overhead constant was added on top of an estimate that already
//      contained the system prompt, double-counting ~4.6k tokens and firing the
//      budget check far too early;
//   b. the cached prompt size was never reset after a summary, so the next
//      iteration measured the pre-summary prompt and summarized again;
//   c. nothing guaranteed the post-summary prompt was actually BELOW the
//      budget, so a summary that freed little re-triggered immediately.
const SUMMARIZE_THRESHOLD = 0.40;
// Absolute ceiling on the full prompt. Measured fixed payload is ~7.7k tokens
// (system prompt ~4.6k + nine core tool schemas ~3.2k); the preserved window is
// capped at RECENT_WINDOW_TOKEN_BUDGET and the summary at ~SUMMARY_TOKEN_ESTIMATE,
// so 18k leaves roughly 5k of headroom — several tool rounds — before the next
// summary. Raising this is not "more cost": it trades a few cached-prefix
// tokens for far fewer (expensive, lossy) summarizer calls.
const WORKING_SET_TOKEN_BUDGET = 18_000;
// Tool schemas are NOT part of `messages`; everything else is counted from the
// message list itself (system prompt included). A single honest constant for
// the schema cost is what removes the double-count above.
const TOOL_SCHEMA_TOKEN_ESTIMATE = 3_200;

const CHARS_PER_TOKEN_ESTIMATE = 3.5;

// Recent history kept verbatim after a compaction. Doubles as the reasoning
// replay window in messagesToOpenAI.
const PRESERVE_RECENT_MESSAGES = 6;
// ...but the verbatim window is bounded by TOKENS, not only a message count: a
// fixed count is meaningless when one scan dump is 2.5k chars and five
// follow-ups are one-liners. MIN guarantees immediate continuity; the token
// budget bounds the rest; MAX stops a run of tiny messages from preserving
// everything (and therefore summarizing nothing).
const MIN_PRESERVE_MESSAGES = 4;
const MAX_PRESERVE_MESSAGES = 12;
const RECENT_WINDOW_TOKEN_BUDGET = 3_000;

// Anti-thrash cooldown: after a summary, BOTH enough messages AND enough fresh
// tokens must accumulate before another is allowed. The token arm matters
// because the preserved window itself counts as "since the summary" and can
// satisfy a pure message count while nothing meaningful has happened.
const MIN_MESSAGES_BEFORE_RECOMPACT = 8;
const MIN_NEW_TOKENS_BEFORE_RECOMPACT = 4_000;

// Projected size of the generated summary, used to estimate the post-compaction
// prompt (so a compaction that cannot actually free space is refused) and to
// reset the caller's cached prompt size after a real compaction.
const SUMMARY_TOKEN_ESTIMATE = 800;
// A compaction must remove at least this fraction of the summarizable history,
// otherwise the extra LLM call costs more than the tokens it saves and the
// detail it destroys is not worth it.
const MIN_COMPACTION_SAVINGS_RATIO = 0.15;

// Tool results older than this many messages are collapsed to a stub: the
// summary and the engagement state already carry what mattered, and re-sending
// full scan output for hundreds of turns was pure token burn.
const RECENT_FULL_TOOL_RESULTS = 8;
const STALE_TOOL_RESULT_CHARS = 250;
// Old tool-call ARGUMENTS are stubbed too: re-sending a 5k-char nmap command
// or a full add_vulnerability payload hundreds of turns later is pure burn.
const STALE_TOOL_CALL_ARGS_CHARS = 200;
// Even fresh (recent-window) tool results get a ceiling: one oversized scan
// dump inside the recent window can blow the whole working-set budget on its
// own. Past this size the head+tail keep the opening status and final verdict.
const RECENT_TOOL_RESULT_MAX_CHARS = 2_500;
// Ceiling on the transcript handed to the summarizer. The engagement state
// already carries hosts/ports/vulns/credentials, so the summarizer only needs
// the narrative; a long 97-case run otherwise ships tens of thousands of chars
// of tool output to buy a summary that fits in ~1k tokens.
const MAX_SUMMARIZER_INPUT_CHARS = 24_000;

/**
 * Estimated token cost of ONE message as it will actually be rendered into the
 * prompt, i.e. AFTER the tool-result and tool-argument caps applied by
 * messagesToOpenAI. Estimating on raw content instead made the budget check
 * wildly pessimistic on scan-heavy sessions and triggered compaction while the
 * real prompt was still small.
 */
function estimateMessageTokens(m: AgentMessageDoc, index: number, total: number): number {
  const isStale = index < total - RECENT_FULL_TOOL_RESULTS;
  let chars = m.content?.length ?? 0;
  if (m.role === "tool") {
    const cap = isStale ? STALE_TOOL_RESULT_CHARS : RECENT_TOOL_RESULT_MAX_CHARS;
    chars = Math.min(chars, cap);
  } else if (m.role === "assistant" && m.toolCalls?.length) {
    for (const tc of m.toolCalls) {
      chars += Math.min(tc.arguments.length, isStale ? STALE_TOOL_CALL_ARGS_CHARS : tc.arguments.length);
    }
  }
  // +1 token per capped message approximates the elision marker text.
  return 4 + Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE) + (chars > 0 ? 1 : 0);
}

export function estimatePromptTokens(messages: AgentMessageDoc[]): number {
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    total += estimateMessageTokens(messages[i], i, messages.length);
  }
  return total;
}

/**
 * Estimated token cost of the tool schemas sent alongside the messages. They are
 * NOT part of the message list, so the compaction budget must add them
 * separately. Computed from the schemas actually in play rather than a fixed
 * constant: the agent can load deferred tools mid-run (load_tools), which grows
 * the payload, and a stale constant would then under-count and let the prompt
 * creep toward the model window. The JSON envelope plus per-tool framing are
 * approximated by the same char/token ratio used everywhere else, which the
 * live calibration lands slightly ABOVE the provider count (safe).
 */
export function estimateToolSchemaTokens(tools: OpenAI.Chat.ChatCompletionTool[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars += JSON.stringify(tool).length + 24; // per-tool envelope
  }
  return chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Messages appended since the last summary, or the whole history when there is
 * no summary yet. Drives the compaction cooldown.
 */
export function messagesSinceSummary(messages: AgentMessageDoc[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) return messages.length - 1 - i;
  }
  return messages.length;
}

/** Estimated tokens appended since the last summary (token arm of the cooldown). */
export function tokensSinceSummary(messages: AgentMessageDoc[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) return estimatePromptTokens(messages.slice(i + 1));
  }
  return estimatePromptTokens(messages);
}

/**
 * Split the summarizable history into what to fold into the summary and what to
 * keep verbatim. The kept suffix is bounded by TOKENS (with a small message
 * floor and ceiling) so the post-compaction prompt lands well below budget; the
 * split is walked back so a tool result is never orphaned from the assistant
 * message that produced it.
 */
export function selectPreservedWindow(nonSystemMessages: AgentMessageDoc[]): {
  toSummarize: AgentMessageDoc[];
  toPreserve: AgentMessageDoc[];
} {
  const total = nonSystemMessages.length;
  let preserveCount = 0;
  let preservedTokens = 0;
  for (let i = total - 1; i >= 0; i--) {
    if (preserveCount >= MAX_PRESERVE_MESSAGES) break;
    const cost = estimateMessageTokens(nonSystemMessages[i], i, total);
    if (preserveCount >= MIN_PRESERVE_MESSAGES && preservedTokens + cost > RECENT_WINDOW_TOKEN_BUDGET) {
      break;
    }
    preserveCount++;
    preservedTokens += cost;
  }

  let splitIndex = total - preserveCount;
  while (splitIndex > 0 && nonSystemMessages[splitIndex]?.role === "tool") {
    splitIndex--;
  }

  return {
    toSummarize: nonSystemMessages.slice(0, splitIndex),
    toPreserve: nonSystemMessages.slice(splitIndex),
  };
}

export interface CompactionPlan {
  shouldCompact: boolean;
  reason: string;
  promptTokens: number;
  budget: number;
  projectedPromptTokens: number;
}

function lastSummaryText(messages: AgentMessageDoc[]): string {
  return messages
    .filter((m) => m.isSummary && m.content)
    .map((m) => m.content!)
    .join("\n\n");
}

/**
 * Decide whether the conversation must be compacted, and — crucially — whether
 * compaction would actually help. Three guards, each of which exists because a
 * measured run hit its failure mode:
 *  1. budget:   the measured full prompt must exceed the working-set cap
 *  2. cooldown: enough NEW messages AND new tokens must have accumulated since
 *     the last summary, otherwise the fixed payload alone forces a re-summary
 *     loop (compress -> one tool call -> compress)
 *  3. savings:  the summary must free a meaningful share of the summarizable
 *     history, so we never pay for a summary that frees nothing — and never one
 *     that frees so little it re-triggers on the very next iteration
 */
export async function planCompaction(
  messages: AgentMessageDoc[],
  lastPromptTokens?: number,
  toolSchemaTokens: number = TOOL_SCHEMA_TOKEN_ESTIMATE,
): Promise<CompactionPlan> {
  const config = await getProvider();
  const limit = getModelContextLimit(config.model);
  const budget = Math.min(limit * SUMMARIZE_THRESHOLD, WORKING_SET_TOKEN_BUDGET);

  const systemMessages = messages.filter((m) => m.role === "system" && !m.isSummary);
  const nonSystem = messages.filter((m) => !m.isSummary && m.role !== "system");

  // Full prompt = measured messages (system prompt included) + the tool schemas
  // that ride along on every call. The provider-reported number, when present,
  // is the ground truth and wins.
  const estimatedFullPrompt = estimatePromptTokens(messages) + toolSchemaTokens;
  const promptTokens = Math.max(estimatedFullPrompt, lastPromptTokens ?? 0);

  const { toPreserve } = selectPreservedWindow(nonSystem);
  const preservedTokens = estimatePromptTokens(toPreserve);
  const projectedPromptTokens =
    estimatePromptTokens(systemMessages) +
    SUMMARY_TOKEN_ESTIMATE +
    preservedTokens +
    toolSchemaTokens;

  const base = { promptTokens, budget, projectedPromptTokens };

  if (promptTokens <= budget) {
    return { shouldCompact: false, reason: "within-budget", ...base };
  }

  // Cooldown first: the cheapest guard, and the one that stops the loop.
  if (messages.some((m) => m.isSummary)) {
    const newMessages = messagesSinceSummary(messages);
    const newTokens = tokensSinceSummary(messages);
    if (
      newMessages < MIN_MESSAGES_BEFORE_RECOMPACT ||
      newTokens < MIN_NEW_TOKENS_BEFORE_RECOMPACT
    ) {
      return { shouldCompact: false, reason: "cooldown", ...base };
    }
  }

  const { toSummarize } = selectPreservedWindow(nonSystem);
  if (toSummarize.length === 0) {
    return { shouldCompact: false, reason: "nothing-to-summarize", ...base };
  }

  // Compare the projected history against the current history (not the full
  // prompt): the system prompt and tool schemas survive compaction untouched,
  // so measuring against the full prompt made a history that was already
  // minimal look like a huge saving.
  const currentHistoryTokens = estimatePromptTokens(nonSystem);
  if (preservedTokens + SUMMARY_TOKEN_ESTIMATE > currentHistoryTokens * (1 - MIN_COMPACTION_SAVINGS_RATIO)) {
    return { shouldCompact: false, reason: "insufficient-savings", ...base };
  }

  return { shouldCompact: true, reason: "over-budget", ...base };
}

export const COMPACTION_TUNING = {
  WORKING_SET_TOKEN_BUDGET,
  TOOL_SCHEMA_TOKEN_ESTIMATE,
  PRESERVE_RECENT_MESSAGES,
  MIN_PRESERVE_MESSAGES,
  MAX_PRESERVE_MESSAGES,
  RECENT_WINDOW_TOKEN_BUDGET,
  MIN_MESSAGES_BEFORE_RECOMPACT,
  MIN_NEW_TOKENS_BEFORE_RECOMPACT,
  MIN_COMPACTION_SAVINGS_RATIO,
  SUMMARY_TOKEN_ESTIMATE,
} as const;

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
- Unverified leads and the exact next action to close each one (keep these even when brief)
- Active shells and their purposes

Do NOT re-list hosts, ports, credentials, vulnerabilities, flag attempts, or file analyses — those are already tracked in the structured engagement state below:

${state.toPromptBlock()}

Summarize only the reasoning and narrative context around these findings.`;
  }
  return FALLBACK_SUMMARIZE_PROMPT;
}

export interface CompactionResult {
  summaryMessage: AgentMessageDoc | null;
  preservedMessages: AgentMessageDoc[];
  /** Estimated prompt size after compaction, so the caller can reset its cache. */
  projectedPromptTokens: number;
}

export async function summarizeMessages(
  messages: AgentMessageDoc[],
  traceContext?: { sessionId?: string; userId?: string },
  engagementState?: EngagementState,
  toolSchemaTokens: number = TOOL_SCHEMA_TOKEN_ESTIMATE,
): Promise<CompactionResult> {
  const fixedMessages = messages.filter((m) => m.role === "system" && !m.isSummary);
  const nonSystemMessages = messages.filter((m) => !m.isSummary && m.role !== "system");

  const { toSummarize, toPreserve } = selectPreservedWindow(nonSystemMessages);

  if (toSummarize.length === 0) {
    return {
      summaryMessage: null,
      preservedMessages: messages,
      projectedPromptTokens: estimatePromptTokens(messages) + toolSchemaTokens,
    };
  }

  const transcript = toSummarize
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        const toolDesc = m.toolCalls
          .map((tc) => `[Tool: ${tc.name}](${tc.arguments.slice(0, 300)})`)
          .join(", ");
        return `Assistant: ${m.content ?? ""} ${toolDesc}`;
      }
      if (m.role === "tool") {
        return `Tool Result (${m.toolName ?? "unknown"}): ${m.content?.slice(0, 500) ?? ""}`;
      }
      return `${m.role}: ${m.content ?? ""}`;
    })
    .join("\n\n");

  // Carry the previous summary forward explicitly. It used to be dropped
  // silently, so every re-summary lost everything summarized two rounds ago —
  // the most damaging defect in a long 97-case run.
  const previous = lastSummaryText(messages);
  const transcriptWithHistory =
    (previous
      ? `Existing summary of the earlier conversation (carry it forward, do not lose detail):\n${previous}\n\n--- NEW EVENTS SINCE THAT SUMMARY ---\n`
      : "") + transcript;

  const boundedTranscript =
    transcriptWithHistory.length <= MAX_SUMMARIZER_INPUT_CHARS
      ? transcriptWithHistory
      : transcriptWithHistory.slice(0, MAX_SUMMARIZER_INPUT_CHARS * 0.7) +
        `\n... [middle of history elided from the summarizer input] ...\n` +
        transcriptWithHistory.slice(-MAX_SUMMARIZER_INPUT_CHARS * 0.25);

  const summaryResult = await invoke_llm({
    messages: [
      { role: "system", content: buildSummarizePrompt(engagementState) },
      { role: "user", content: boundedTranscript },
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

  const result: AgentMessageDoc[] = [...fixedMessages, summaryMessage, ...toPreserve];

  return {
    summaryMessage,
    preservedMessages: result,
    projectedPromptTokens:
      estimatePromptTokens(fixedMessages) +
      SUMMARY_TOKEN_ESTIMATE +
      estimatePromptTokens(toPreserve) +
      toolSchemaTokens,
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