import OpenAI from "openai";
import { invoke_llm } from "../utils/llm/invoke";
import { getProvider } from "../utils/llm/orchestrator";
import { AgentMessageDoc } from "../models/Sessions/Sessions.model";
import { EngagementState } from "./engagement-state";
import { getModelContextLimit } from "../utils/modelMetadata";
import {
  elideMiddle,
  estimateTokens,
  formatMessageForTranscript,
} from "../utils/transcript";
import {
  estimateMessageTokens,
  estimatePromptTokens,
  messagesSinceSummary,
  PRESERVE_RECENT_MESSAGES,
  tokensSinceSummary,
} from "./context.service";

// ─── Compaction ─────────────────────────────────────────────────────────
// Owns the summarization state machine: the budget plan, the preserve/summarize
// split, the summarizer call, and the per-run ContextBudget that keeps the
// cached prompt size in lock-step with the summary it produces. The measured
// prompt projection this plans against lives in context.service.ts.

// Working-set ceiling: how big a prompt the agent may carry before paying for a
// (lossy) summarizer call. The trigger is a RESERVE off the model's window, not a
// fixed fraction of it — the invariant is the room the next turn needs, so the
// percentage lands where that puts it (~80% of a 200k window, ~69% of a 128k one)
// instead of being asserted for every model. The reserve is the model's own
// output ceiling (the `max_tokens` we send with every request, see
// MODEL_MAX_OUTPUT_TOKENS) plus a margin for the estimate's measured error (~5%
// high) and a tool result that arrives oversized between planning and the call.
// The coupling is asserted in tests: raising the model's output ceiling without
// raising this reserve fails the build, and a model with a smaller ceiling than
// ours simply compacts later than it must, never past the window. The measured
// fixed payload is ~7.7k tokens (system prompt ~4.6k + nine core tool schemas
// ~3.2k); the preserved window is capped at RECENT_WINDOW_TOKEN_BUDGET and the
// summary at ~SUMMARY_TOKEN_ESTIMATE. Raising this is not "more cost": it trades
// a few cached-prefix tokens for far fewer (expensive, lossy) summarizer calls.
const WORKING_SET_MAX_OUTPUT_TOKENS = 32_000;
const WORKING_SET_RESERVE_MARGIN_TOKENS = 8_000;
const WORKING_SET_RESERVE_TOKENS =
  WORKING_SET_MAX_OUTPUT_TOKENS + WORKING_SET_RESERVE_MARGIN_TOKENS;

// A window too small to give up that reserve still needs a usable working set, so
// the reserve never takes more than half of it, and no plan may ever claim more
// than 90% — the hard stop before the provider's own limit.
const WORKING_SET_MAX_RESERVE_SHARE = 0.5;
const WORKING_SET_MAX_WINDOW_SHARE = 0.9;

// Absolute ceiling for windows big enough that a reserve-based trigger would
// carry a prompt no per-turn latency or cost budget should pay for: a 1M window
// plans 200k here, not 960k.
const WORKING_SET_TOKEN_BUDGET = 200_000;

// Tool schemas are NOT part of `messages`; everything else is counted from the
// message list itself (system prompt included). A single honest constant for
// the schema cost is what removes the double-count above.
const TOOL_SCHEMA_TOKEN_ESTIMATE = 3_200;

// ...but the verbatim window is bounded by TOKENS, not only a message count: a
// fixed count is meaningless when one scan dump is 2.5k chars and five
// follow-ups are one-liners. MIN guarantees immediate continuity; the token
// budget bounds the rest; MAX stops a run of tiny messages from preserving
// everything (and therefore summarizing nothing).
const MIN_PRESERVE_MESSAGES = 4;
const MAX_PRESERVE_MESSAGES = 16;
const RECENT_WINDOW_TOKEN_BUDGET = 6_000;

// Anti-thrash cooldown: after a summary, BOTH enough messages AND enough fresh
// tokens must accumulate before another is allowed. The token arm matters
// because the preserved window itself counts as "since the summary" and can
// satisfy a pure message count while nothing meaningful has happened. It scales
// with the working set: a fifth of a wide budget is not a trivial amount of work.
const MIN_MESSAGES_BEFORE_RECOMPACT = 8;
const MIN_NEW_TOKENS_BEFORE_RECOMPACT = 12_000;

// Projected size of the generated summary, used to estimate the post-compaction
// prompt (so a compaction that cannot actually free space is refused) and to
// reset the caller's cached prompt size after a real compaction. Priced at what
// a summary that keeps reasoning, leads and open questions actually costs, not at
// the bare minimum a terse one would.
const SUMMARY_TOKEN_ESTIMATE = 1_200;

// A compaction must remove at least this fraction of the summarizable history,
// otherwise the extra LLM call costs more than the tokens it saves and the
// detail it destroys is not worth it.
const MIN_COMPACTION_SAVINGS_RATIO = 0.15;

// Ceiling on the transcript handed to the summarizer. The engagement state
// already carries hosts/ports/vulns/credentials, so the summarizer only needs
// the narrative — but that narrative is what the next run has to reason from, so
// the ceiling is generous: it is one call either way, and eliding the middle of
// a long run is what loses the thread that ties two findings together.
const MAX_SUMMARIZER_INPUT_CHARS = 60_000;

/**
 * The prompt size at which a compaction becomes worth it, from the model's own
 * window: the window minus the reserve, never below half the window (a small
 * window cannot afford the full reserve) and never above 90% of it.
 */
export function workingSetBudget(limit: number): number {
  const reserve = Math.min(
    WORKING_SET_RESERVE_TOKENS,
    limit * WORKING_SET_MAX_RESERVE_SHARE,
  );
  return Math.min(
    limit - reserve,
    limit * WORKING_SET_MAX_WINDOW_SHARE,
    WORKING_SET_TOKEN_BUDGET,
  );
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
  contextLimit?: number,
): Promise<CompactionPlan> {
  // The caller who already knows the orchestrator's model injects the limit;
  // the global provider read is only the fallback for direct callers (tests).
  const limit = contextLimit ?? getModelContextLimit((await getProvider()).model);
  const budget = workingSetBudget(limit);

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
  WORKING_SET_MAX_OUTPUT_TOKENS,
  WORKING_SET_RESERVE_MARGIN_TOKENS,
  WORKING_SET_RESERVE_TOKENS,
  WORKING_SET_MAX_RESERVE_SHARE,
  WORKING_SET_MAX_WINDOW_SHARE,
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
  MAX_SUMMARIZER_INPUT_CHARS,
} as const;

/**
 * Per-run owner of the compaction state machine: the cached prompt size and
 * the summarize/reset invariant live HERE, not in the agent loop. The
 * invariant that once caused the re-summary loop — resetting the cached prompt
 * size to the POST-compaction projection, so the next iteration never measures
 * a prompt that no longer exists — is enforced inside compact(), where it can
 * be tested without Mongo, SSE, or a live LLM.
 */
export class ContextBudget {
  private lastPromptTokens?: number;

  /**
   * The orchestrator's model context limit, when the caller knows it. Passing
   * it keeps the budget seam free of the global provider config; omit it and
   * planCompaction falls back to reading the configured provider.
   */
  constructor(private readonly contextLimit?: number) {}

  /** Ground-truth prompt size reported by the provider after each call. */
  observe(promptTokens: number): void {
    this.lastPromptTokens = promptTokens;
  }

  /** Decide whether this iteration must compact (see planCompaction). */
  plan(
    messages: AgentMessageDoc[],
    toolSchemaTokens: number,
  ): Promise<CompactionPlan> {
    return planCompaction(messages, this.lastPromptTokens, toolSchemaTokens, this.contextLimit);
  }

  /**
   * Run the summarization and reset the cached prompt size to the
   * post-compaction projection.
   */
  async compact(
    messages: AgentMessageDoc[],
    opts: {
      traceContext?: { sessionId?: string; userId?: string };
      engagementState?: EngagementState;
      toolSchemaTokens: number;
    },
  ): Promise<CompactionResult> {
    const result = await summarizeMessages(
      messages,
      opts.toolSchemaTokens,
      opts.traceContext,
      opts.engagementState,
    );
    this.lastPromptTokens = result.projectedPromptTokens;
    return result;
  }
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

// ─── Conversation input bounding ───────────────────────────────────────────
// The window arithmetic for LLM calls that receive the whole conversation —
// /summarize and /export — lives here with the other window rules, not at the
// call sites. Keep the latest messages when the full history would exceed the
// model's input budget: 60% of the context limit, minus a fixed allowance for
// the caller's system prompt, with a small per-entry fudge for the joiner.
const CONVERSATION_INPUT_BUDGET_SHARE = 0.6;
const CONVERSATION_PROMPT_OVERHEAD_TOKENS = 500;

async function conversationInputTokenBudget(): Promise<number> {
  const config = await getProvider();
  const limit = getModelContextLimit(config.model);
  return Math.floor(limit * CONVERSATION_INPUT_BUDGET_SHARE) - CONVERSATION_PROMPT_OVERHEAD_TOKENS;
}

/**
 * The conversation history formatted for the transcript and bounded to the
 * model's input budget: the full text when it fits, otherwise the latest
 * messages that do.
 */
export async function boundedConversationText(messages: any[]): Promise<string> {
  const maxTokens = await conversationInputTokenBudget();

  const formatted = messages.map((m) => formatMessageForTranscript(m));

  const fullText = formatted.join("\n\n");
  if (estimateTokens(fullText) <= maxTokens) {
    return fullText;
  }

  const kept: string[] = [];
  let tokenBudget = maxTokens;

  for (let i = formatted.length - 1; i >= 0; i--) {
    const entry = formatted[i];
    const entryTokens = estimateTokens(entry) + 2;
    if (tokenBudget - entryTokens < 0) break;
    kept.unshift(entry);
    tokenBudget -= entryTokens;
  }

  return kept.join("\n\n");
}

export async function summarizeMessages(
  messages: AgentMessageDoc[],
  // Required, not defaulted: the agent loop prices the real in-play schemas,
  // so a silent fallback to the fixed 3.2k estimate would quietly under-price
  // the compaction's headroom. Tests without a schema payload pass 0.
  toolSchemaTokens: number,
  traceContext?: { sessionId?: string; userId?: string },
  engagementState?: EngagementState,
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
    .map((m) => formatMessageForTranscript(m, 300))
    .join("\n\n");

  // Carry the previous summary forward explicitly. It used to be dropped
  // silently, so every re-summary lost everything summarized two rounds ago —
  // the most damaging defect in a long 97-case run.
  const previous = lastSummaryText(messages);
  const transcriptWithHistory =
    (previous
      ? `Existing summary of the earlier conversation (carry it forward, do not lose detail):\n${previous}\n\n--- NEW EVENTS SINCE THAT SUMMARY ---\n`
      : "") + transcript;

  const boundedTranscript = elideMiddle(
    transcriptWithHistory,
    MAX_SUMMARIZER_INPUT_CHARS,
    "\n... [middle of history elided from the summarizer input] ...\n",
    0.7,
  );

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
