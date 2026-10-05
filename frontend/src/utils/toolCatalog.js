/**
 * The tool catalog: everything the UI needs to render one agent tool call,
 * keyed by the backend tool name. Adding an agent tool means adding (or
 * skipping) an entry here — the renderer in ToolCallBlock falls back to the
 * tool name and a JSON dump for unknown tools, so an entry is only needed
 * when the default rendering is not good enough.
 */

export const TOOL_LABELS = {
  run_bash: "Bash",
  run_python_script: "Python Script",
  run_install_tool: "Install Tool",
  ask_user: "Question",
  spawn_shell: "Spawn Shell",
  write_to_shell: "Write to Shell",
  read_shell: "Read Shell",
  list_shells: "List Shells",
  close_shell: "Close Shell",
  view_image: "View Image",
  send_to_burp_repeater: "Burp Repeater",
  send_to_burp_intruder: "Burp Intruder",
  search_burp_proxy_history: "Burp Proxy History",
  burp_collaborator: "Burp Collaborator",
  browser_action: "Browser Action",
  magnitude_browser: "Browser Agent",
  update_engagement_state: "Engagement State",
  wstg_test_plan: "WSTG Test Plan",
  map_finding_owasp: "OWASP Mapping",
  generate_pentest_report: "Pentest Report",
};

// The browser-coupling rule made explicit: tools whose name matches drive the
// live Browser Agent panel (unfold while streaming, fold back when done).
export function isBrowserTool(toolName) {
  return /browser/i.test(toolName || "");
}

export function parseArgs(args) {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

export function formatArgsPreview(toolName, parsed) {
  if (toolName === "run_bash") return parsed.command ?? "";
  if (toolName === "run_python_script")
    return parsed.file_name ?? "inline script";
  if (toolName === "run_install_tool") return parsed.tool_name ?? "";
  if (toolName === "ask_user") return parsed.question ?? "";
  if (toolName === "spawn_shell") return parsed.label ?? "";
  if (toolName === "write_to_shell")
    return `[${parsed.shell_id}] ${(parsed.input ?? "").slice(0, 60)}`;
  if (toolName === "read_shell") return `[${parsed.shell_id}]`;
  if (toolName === "close_shell") return `[${parsed.shell_id}]`;
  if (toolName === "view_image") return parsed.image_path ?? "";
  if (toolName === "send_to_burp_repeater" || toolName === "send_to_burp_intruder") {
    const req = parsed.raw_request ?? "";
    const firstLine = req.split(/\r?\n/)[0] || "";
    return parsed.host ?? firstLine.split(" ")[1] ?? "";
  }
  if (toolName === "search_burp_proxy_history")
    return `${parsed.query ?? ""} ${parsed.host ?? ""}`.trim();
  if (toolName === "burp_collaborator") return parsed.action ?? "";
  if (toolName === "browser_action")
    return `${parsed.url ?? ""} ${(parsed.goal ?? "").slice(0, 60)}`.trim();
  if (toolName === "magnitude_browser")
    return `${parsed.url ?? ""} ${(parsed.task ?? parsed.goal ?? "").slice(0, 50)}`.trim();
  if (toolName === "update_engagement_state")
    return `${parsed.action ?? ""} ${parsed.title ?? parsed.host ?? parsed.port ?? ""}`.trim();
  if (toolName === "wstg_test_plan")
    return `${parsed.action ?? ""} ${parsed.test_id ?? parsed.depth ?? parsed.target ?? ""}`.trim();
  if (toolName === "map_finding_owasp")
    return `${parsed.vulnerability_id ?? parsed.title ?? parsed.wstg_id ?? ""}`.trim();
  if (toolName === "generate_pentest_report")
    return `${parsed.path ?? parsed.target ?? "draft report"}`.trim();
  return JSON.stringify(parsed);
}

export function getCodePreview(toolName, parsed) {
  if (toolName === "run_bash") {
    return { code: parsed.command ?? "", language: "bash" };
  }
  if (toolName === "run_install_tool") {
    return null;
  }
  if (toolName === "run_python_script") {
    return { code: parsed.script ?? "", language: "python" };
  }
  // Historical: shell_exec was an MCP tool removed in d28cedc; old archived
  // sessions can still contain calls to it.
  if (toolName === "shell_exec") {
    return { code: parsed.command ?? "", language: "bash" };
  }
  return null;
}
