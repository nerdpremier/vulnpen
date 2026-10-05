import { DEFERRED_TOOL_NAMES } from "./names";
import { parseToolArguments } from "../utils/toolArguments";

// Tools excluded from the always-loaded schema set. The agent re-sends every
// tool schema on each tool-call iteration, so keeping the Burp suite, the
// interactive shell (C2) group and the end-of-engagement reporting tools out
// of the default prompt saves ~3k tokens per call. Web-app sessions rarely
// touch the shell tools; anyone doing network exploitation loads them with
// the `load_tools` meta tool, and once loaded for a session they stay loaded.
// Kept in its own module: both the registry and the load_tools handler need
// it, and a handler importing the registry would be a circular import.
// The names themselves live in tools/names.ts.
export const DEFERRED_TOOLS = new Set(DEFERRED_TOOL_NAMES);

/**
 * Split a requested tool-name list into deferred names to load and unknown
 * names to report back. The one filter both the load_tools handler and the
 * agent loop's in-memory mirror consume, so the two can never disagree about
 * what counts as a loadable tool.
 */
export function filterDeferredToolNames(requested: unknown): {
  valid: string[];
  unknown: string[];
} {
  const names = Array.isArray(requested) ? requested : [];
  return {
    valid: names.filter((name): name is string => typeof name === "string" && DEFERRED_TOOLS.has(name)),
    unknown: names.filter((name) => !(typeof name === "string" && DEFERRED_TOOLS.has(name))),
  };
}

/**
 * Which deferred tools a turn's tool calls request to load. The one parser
 * both the load_tools handler and the agent loop's in-memory mirror run over
 * the assistant's tool calls, so the persisted set and the in-memory set can
 * never disagree about what a call loaded.
 */
export function requestedDeferredNames(
  toolCalls: { name: string; arguments: string }[],
): string[] {
  const names: string[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== "load_tools") continue;
    let args: { tools?: unknown } | undefined;
    try {
      args = parseToolArguments(tc.arguments).args;
    } catch {
      continue;
    }
    names.push(...filterDeferredToolNames(args?.tools).valid);
  }
  return names;
}

/** Merge newly loaded names into a session's loaded set, keeping it unique. */
export function mergeLoadedTools(
  current: string[] | undefined,
  newlyLoaded: string[],
): string[] {
  return [...new Set([...(current ?? []), ...newlyLoaded])];
}
