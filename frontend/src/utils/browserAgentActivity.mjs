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

/**
 * Whether the browser has been used in the run that is happening now.
 *
 * The run boundary is the last user message: everything after it belongs to the
 * current turn. Counting a finished call matters as much as counting a live one
 * — a browser step that just completed is exactly the moment the panel must
 * stay open — so this deliberately ignores `streaming`.
 */
export function isBrowserUsedInRun(messages) {
  if (!Array.isArray(messages)) return false;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  return messages
    .slice(lastUser + 1)
    .some((m) => m?.role === "tool" && isBrowserTool(m.toolName));
}

/**
 * Whether the agent should own the browser panel right now.
 *
 * `browserActive` is true only while a single browser_action call is in flight,
 * and the model spends seconds thinking between two of them. Owning the panel
 * on that flag alone made it fold and reopen once per browser step — and the
 * panel is the live noVNC view, so every fold tore down the embedded desktop's
 * connection and opened a new one.
 *
 * So the panel follows the RUN: once the browser has been used in this run, it
 * stays open until the run itself ends.
 */
export function agentOwnsBrowserPanel({ browserActive, runLive, browserUsed }) {
  if (browserActive) return true;
  return Boolean(runLive) && Boolean(browserUsed);
}
