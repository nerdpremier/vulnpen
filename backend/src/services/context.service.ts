import OpenAI from "openai";
import { AgentMessageDoc } from "../models/Sessions/Sessions.model";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  elideMiddle,
} from "../utils/transcript";

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

// Recent history kept verbatim after a compaction. Doubles as the reasoning
// replay window in messagesToOpenAI.
export const PRESERVE_RECENT_MESSAGES = 6;

// Tool results older than this many messages are collapsed to a stub: the
// summary and the engagement state already carry what mattered, and re-sending
// full scan output for hundreds of turns was pure token burn.
const RECENT_FULL_TOOL_RESULTS = 8;
// Both "how recent counts as full fidelity" windows live together so a change
// to one is a deliberate edit, not a silent drift between the elider and the
// estimator (the compaction budget is only honest while they agree).
export const RECENT_WINDOW = {
  toolResults: RECENT_FULL_TOOL_RESULTS,
  messages: PRESERVE_RECENT_MESSAGES,
} as const;


const STALE_TOOL_RESULT_CHARS = 250;
// Old tool-call ARGUMENTS are stubbed too: re-sending a 5k-char nmap command
// or a full add_vulnerability payload hundreds of turns later is pure burn.
const STALE_TOOL_CALL_ARGS_CHARS = 200;
// Even fresh (recent-window) tool results get a ceiling: one oversized scan
// dump inside the recent window can blow the whole working-set budget on its
// own. Past this size the head+tail keep the opening status and final verdict.
const RECENT_TOOL_RESULT_MAX_CHARS = 2_500;

// ─── Context window rules ─────────────────────────────────────────────────
// One owner for the elision policy: the token estimator and the prompt
// renderer both consume these helpers, so the estimate can never drift from
// what messagesToOpenAI actually sends. Before this seam the four rules below
// (staleness window, tool-result caps, tool-args cap, reasoning replay window)
// were written twice — once per consumer — and only comments kept them in step.

/** Messages older than this many from the end are "stale": their tool output
 *  and arguments collapse to stubs. */
export function isStaleMessage(index: number, total: number): boolean {
  return index < total - RECENT_WINDOW.toolResults;
}

/** The character ceiling a tool result renders at, staleness-dependent. */
export function toolResultCap(isStale: boolean): number {
  return isStale ? STALE_TOOL_RESULT_CHARS : RECENT_TOOL_RESULT_MAX_CHARS;
}

/** Render a tool result under the staleness-dependent cap (head+tail stub). */
export function elideToolResult(content: string, isStale: boolean): string {
  const cap = toolResultCap(isStale);
  const label = isStale ? "older tool output" : "tool output";
  return elideMiddle(
    content,
    cap,
    `\n... [${content.length - cap} chars of this ${label} elided from context] ...\n`,
  );
}

/** Render tool-call arguments: stale ones collapse to a head+tail stub. */
export function elideToolCallArgs(args: string, isStale: boolean): string {
  if (!isStale || args.length <= STALE_TOOL_CALL_ARGS_CHARS) return args;
  // The stub must stay VALID JSON: upstreams parse tool-call arguments and
  // reject the whole request with "invalid request error" when the elision
  // marker breaks the string mid-object (seen on Novita via OpenRouter).
  try {
    const stubbed = JSON.stringify(stubJsonValues(JSON.parse(args), ELIDED_ARG_VALUE_CHARS));
    if (stubbed.length <= STALE_TOOL_CALL_ARGS_CHARS * 4) return stubbed;
  } catch {
    // args were not valid JSON — fall through to the flat stub below.
  }
  return JSON.stringify({
    note: `older tool-call arguments (${args.length} chars) elided from context`,
  });
}

/** Per-string ceiling inside a stubbed arguments object. */
const ELIDED_ARG_VALUE_CHARS = 80;

/**
 * Shrink long strings and long arrays inside a parsed arguments object,
 * keeping the key structure the model wrote: it can still see WHICH
 * parameters it passed and roughly what they held, without re-sending a 5k
 * char scan dump.
 */
function stubJsonValues(value: unknown, cap: number): unknown {
  if (typeof value === "string") {
    if (value.length <= cap) return value;
    const half = Math.floor(cap / 2);
    return (
      value.slice(0, half) +
      ` …[${value.length - cap} chars elided from context]… ` +
      value.slice(-half)
    );
  }
  if (Array.isArray(value)) {
    if (JSON.stringify(value).length <= cap) return value;
    // Head+tail items with an elision marker — still a JSON array.
    const elided = value.length - 3;
    return [
      stubJsonValues(value[0], cap),
      `…[${elided} items elided from context]…`,
      stubJsonValues(value[value.length - 1], cap),
    ];
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stubJsonValues(inner, cap);
    }
    return out;
  }
  return value;
}

/** Assistant messages from this index on may replay their reasoning_content. */
export function reasoningReplayWindowStart(total: number): number {
  return total - RECENT_WINDOW.messages;
}

/**
 * Estimated token cost of ONE message as it will actually be rendered into the
 * prompt, i.e. AFTER the tool-result and tool-argument caps applied by
 * messagesToOpenAI. Estimating on raw content instead made the budget check
 * wildly pessimistic on scan-heavy sessions and triggered compaction while the
 * real prompt was still small.
 *
 * Deliberately NOT counted: reasoning_content. The renderer replays it only
 * for kimi providers (includeReasoningContent), which the estimator cannot
 * know — counting it unconditionally would over-compact every other provider.
 */
export function estimateMessageTokens(m: AgentMessageDoc, index: number, total: number): number {
  const isStale = isStaleMessage(index, total);
  let chars = m.content?.length ?? 0;
  if (m.role === "tool") {
    chars = Math.min(chars, toolResultCap(isStale));
  } else if (m.role === "assistant" && m.toolCalls?.length) {
    for (const tc of m.toolCalls) {
      // Mirrors elideToolCallArgs: stale args collapse to a JSON-valid stub,
      // fresh args pass through whole.
      chars += isStale
        ? Math.min(tc.arguments.length, elideToolCallArgs(tc.arguments, true).length)
        : tc.arguments.length;
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
  const reasoningWindowStart = reasoningReplayWindowStart(messages.length);

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
            arguments: elideToolCallArgs(
              tc.arguments,
              isStaleMessage(index, messages.length),
            ),
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
      // readable while it is still being acted on. Same rule object the
      // estimator consumes.
      const isStale = isStaleMessage(index, messages.length);
      if (content.length > toolResultCap(isStale)) {
        content = elideToolResult(content, isStale);
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