import type { AgentMessageDoc } from "../models/Sessions/Sessions.model";

/**
 * Dynamic trace tags for an LLM call, derived from where the conversation
 * stands: a trailing run of tool results means we are analyzing their output
 * (tagged with the tools involved), anything else means the model is planning.
 * Pure so the tagging rule is testable without the agent loop around it.
 */
export function buildTraceTags(
  prefix: string,
  messages: AgentMessageDoc[],
  extra?: string[],
): { tags: string[]; phase: string } {
  const trailingTools: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" && messages[i].toolName) {
      trailingTools.push(messages[i].toolName!);
    } else {
      break;
    }
  }

  const tags = [prefix];
  if (extra) tags.push(...extra);

  if (trailingTools.length === 0) {
    tags.push("planning");
    return { tags, phase: "plan" };
  }

  tags.push("analyze");
  const uniqueTools = [...new Set(trailingTools)];
  tags.push(...uniqueTools);
  return { tags, phase: "analyze" };
}
