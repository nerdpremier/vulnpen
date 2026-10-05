/**
 * Tool-name groups referenced outside the registry, written once.
 *
 * The registry (tools/registry.ts) stays authoritative for what exists — every
 * name here must be a registered tool name (guarded by tests/toolNames.test.ts).
 * These groups exist so "which tools are the shell group / Burp suite / browser
 * / deferred" is defined in one file instead of re-listed as string literals in
 * deferred.ts, toolAvailability.ts, prompt prose and handler code.
 */
export const SHELL_TOOL_NAMES = [
  "spawn_shell",
  "write_to_shell",
  "read_shell",
  "list_shells",
  "close_shell",
] as const;

export const BURP_TOOL_NAMES = [
  "send_to_burp_repeater",
  "send_to_burp_intruder",
  "burp_collaborator",
  "search_burp_proxy_history",
] as const;

export const BROWSER_TOOL_NAMES = ["browser_action"] as const;

export const REPORTING_TOOL_NAMES = [
  "map_finding_owasp",
  "generate_pentest_report",
] as const;

/** Tools excluded from the always-loaded schema set until load_tools loads them. */
export const DEFERRED_TOOL_NAMES: readonly string[] = [
  ...SHELL_TOOL_NAMES,
  ...BURP_TOOL_NAMES,
  ...REPORTING_TOOL_NAMES,
];
