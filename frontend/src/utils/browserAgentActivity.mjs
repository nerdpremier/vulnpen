import { isBrowserTool } from "./toolCatalog.js";

/**
 * Whether the agent is currently driving the browser. Derived from the
 * session's message list (any streaming browser-tool call) instead of
 * CustomEvents so the panel can never leak open — the flag falls as soon as
 * the message list says the call finished, no matter how the tool ended.
 */
export function isBrowserAgentActive(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => m?.role === "tool" && m.streaming === true && isBrowserTool(m.toolName),
  );
}
