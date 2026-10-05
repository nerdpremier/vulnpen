import { DEFERRED_TOOL_NAMES } from "./names";

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
