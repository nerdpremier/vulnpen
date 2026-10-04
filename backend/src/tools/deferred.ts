// Tools excluded from the always-loaded schema set. The agent re-sends every
// tool schema on each tool-call iteration, so keeping the Burp suite, the
// interactive shell (C2) group and the end-of-engagement reporting tools out
// of the default prompt saves ~3k tokens per call. Web-app sessions rarely
// touch the shell tools; anyone doing network exploitation loads them with
// the `load_tools` meta tool, and once loaded for a session they stay loaded.
// Kept in its own module: both the registry and the load_tools handler need
// it, and a handler importing the registry would be a circular import.
export const DEFERRED_TOOLS = new Set([
  "spawn_shell",
  "write_to_shell",
  "read_shell",
  "list_shells",
  "close_shell",
  "send_to_burp_repeater",
  "send_to_burp_intruder",
  "burp_collaborator",
  "search_burp_proxy_history",
  "map_finding_owasp",
  "generate_pentest_report",
]);
