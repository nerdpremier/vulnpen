import { ToolDefinition } from "../types";
import { findCapabilityForCommand } from "../../capabilities/registry";
import { shellSafetyDetail } from "../../utils/consentDetail";

const runBash: ToolDefinition = {
  name: "run_bash",
  description:
    "Execute a bash command on the Kali Linux attack box and return its full output. " +
    "Uses a one-shot exec channel — the command runs to completion (or timeout) and " +
    "stdout+stderr are returned. Use this for all CLI tools (nmap, gobuster, sqlmap, " +
    "ffuf, curl, etc.). For long-running or interactive tasks, use spawn_shell + " +
    "write_to_shell + read_shell instead. " +
    "The engagement is a proof of concept: never run a command that deletes, overwrites " +
    "or disables data, accounts or configuration on the target.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The full bash command to execute",
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout in seconds (default 300). The command is killed if it exceeds this.",
      },
    },
    required: ["command"],
  },
  timeoutMs: 300_000,
  shouldRequireConsent(args, ctx) {
    return shellSafetyDetail(args.command ?? "", ctx) !== undefined;
  },
  describeSafety(args, ctx) {
    return shellSafetyDetail(args.command ?? "", ctx);
  },
  async execute(args, ctx) {
    const command = args.command;
    if (!command) return { output: "Error: no command provided", exitCode: 1 };

    const timeoutMs = args.timeout_seconds ? args.timeout_seconds * 1000 : this.timeoutMs;
    const { output, exitCode } = await ctx.runCommand(command, timeoutMs);

    const files: string[] = [];
    // Heuristic output-file detection: `-o`/`-oN`/`--output` flags and
    // `>`/`>>` redirects. Guarded so flag-like tokens (`find . -or ...`),
    // /dev/null and bare words that don't look like paths don't register.
    for (const match of command.matchAll(
      /(?:^|\s)-o[a-zA-Z]?\s+(\S+)|(?:^|\s)--output[= ](\S+)|(?:^|\s)>{1,2}\s*(\S+)/g,
    )) {
      const token = (match[1] || match[2] || match[3])?.replace(/^["']|["']$/g, "");
      if (!token || token.startsWith("-") || token === "/dev/null") continue;
      const looksLikeFile = token.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(token);
      if (!looksLikeFile) continue;
      if (!files.includes(token)) files.push(token);
    }

    const result: { output: string; exitCode: number; files?: string[]; installSuggestion?: { name: string; label: string; installCommand: string; size: string } } = { output, exitCode, files };

    if (exitCode !== 0) {
      const suggestion = detectMissingCapability(output, command);
      if (suggestion) {
        result.installSuggestion = suggestion;
      }
    }

    return result;
  },
};

const NOT_FOUND_PATTERNS = [
  /(\S+): (?:command )?not found/i,
  /bash: (\S+): No such file or directory/i,
  /No module named ['"]*(\S+?)['"]*\s*$/im,
  /ModuleNotFoundError: No module named ['"]*(\S+?)['"]*$/im,
  /ImportError: No module named ['"]*(\S+?)['"]*$/im,
];

function detectMissingCapability(output: string, command: string): { name: string; label: string; installCommand: string; size: string } | null {
  for (const pattern of NOT_FOUND_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      const missingName = match[1];
      const cap = findCapabilityForCommand(missingName);
      if (cap) {
        return { name: cap.name, label: cap.label, installCommand: cap.installCommand, size: cap.size };
      }
    }
  }

  const firstWord = command.trim().split(/\s+/)[0];
  if (firstWord && output.includes("not found")) {
    const cap = findCapabilityForCommand(firstWord);
    if (cap) {
      return { name: cap.name, label: cap.label, installCommand: cap.installCommand, size: cap.size };
    }
  }

  return null;
}

export default runBash;
