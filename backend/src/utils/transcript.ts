import type { AgentMessageDoc } from "../models/Sessions/Sessions.model";

/**
 * Transcript vocabulary shared by context compaction, the slash-command
 * summarizers and tool-output rendering: one char/token ratio, one way to
 * format a message for a summarizer, one way to elide the middle of a string.
 */

export const CHARS_PER_TOKEN_ESTIMATE = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * One message rendered as a transcript line for an LLM summarizer.
 * `toolArgsChars` caps the tool-call arguments inline (the compaction
 * summarizer uses 300; callers that need full arguments omit the cap).
 */
export function formatMessageForTranscript(
  m: Pick<AgentMessageDoc, "role" | "content" | "toolName" | "toolCalls">,
  toolArgsChars?: number,
): string {
  if (m.role === "assistant" && m.toolCalls?.length) {
    const toolDesc = m.toolCalls
      .map((tc) => {
        const args = toolArgsChars === undefined ? tc.arguments : tc.arguments.slice(0, toolArgsChars);
        return `[Tool: ${tc.name}](${args})`;
      })
      .join(", ");
    return `Assistant: ${m.content ?? ""} ${toolDesc}`;
  }
  if (m.role === "tool") {
    return `Tool Result (${m.toolName ?? "unknown"}): ${m.content?.slice(0, 500) ?? ""}`;
  }
  return `${m.role}: ${m.content ?? ""}`;
}

/**
 * Keep the head and tail of an over-long string, eliding the middle. Head and
 * tail split `headRatio`/`1 - headRatio` of maxChars; a weighted split (0.4)
 * keeps verdicts that live in the tail, the default keeps a balanced excerpt.
 * The marker is inserted verbatim between head and tail — pass any newline
 * padding you want inside it.
 */
export function elideMiddle(
  text: string,
  maxChars: number,
  marker: string,
  headRatio = 0.5,
): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * headRatio);
  const tail = maxChars - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}
