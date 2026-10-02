import { ToolDefinition } from "../types";
import { findCapabilityForCommand } from "../../capabilities/registry";
import { shellSafetyDetail } from "../../utils/consentDetail";
import crypto from "crypto";

const MODULE_NOT_FOUND_PATTERNS = [
  /No module named ['"]*(\S+?)['"]*\s*$/im,
  /ModuleNotFoundError: No module named ['"]*(\S+?)['"]*$/im,
  /ImportError: No module named ['"]*(\S+?)['"]*$/im,
];

async function detectMissingModule(
  output: string,
  runCommand: (cmd: string, timeoutMs?: number) => Promise<{ output: string; exitCode: number }>,
) {
  for (const pattern of MODULE_NOT_FOUND_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      const cap = findCapabilityForCommand(match[1]);
      // The pattern only reads the output text, so confirm the module is
      // genuinely absent before offering an install.
      if (cap && (await isGenuinelyMissing(cap, runCommand))) {
        return { name: cap.name, label: cap.label, installCommand: cap.installCommand, size: cap.size };
      }
    }
  }
  return null;
}

async function isGenuinelyMissing(
  cap: { name: string; checkCommand?: string },
  runCommand: (cmd: string, timeoutMs?: number) => Promise<{ output: string; exitCode: number }>,
): Promise<boolean> {
  if (!cap.checkCommand) return true;
  const probe = await runCommand(`{ ${cap.checkCommand}; } >/dev/null 2>&1`, 10_000);
  return probe.exitCode !== 0;
}

const runPythonScript: ToolDefinition = {
  name: "run_python_script",
  description:
    "Execute a Python 3 script on the attack box. Use this for custom exploits, " +
    "data parsing, protocol interactions, brute-force logic, or any task requiring Python libraries " +
    "like requests, socket, struct, pwntools, etc. " +
    "Scripts always run in-memory via stdin. If file_name is provided, the script is also saved to disk for reference. " +
    "Never script a destructive action against the target (delete, overwrite, DROP/TRUNCATE, --os-shell, --file-write): " +
    "this engagement is proof of concept only.",
  parameters: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "Full Python script content",
      },
      file_name: {
        type: "string",
        description: "Optional: save the script to this filename for reference (e.g. 'exploit.py'). Must be a plain filename, not a path. The script still runs in-memory regardless.",
      },
    },
    required: ["script"],
  },
  timeoutMs: 300_000,
  shouldRequireConsent(args, ctx) {
    return shellSafetyDetail(args.script ?? "", ctx) !== undefined;
  },
  describeSafety(args, ctx) {
    const scope = shellSafetyDetail(args.script ?? "", ctx);
    if (scope) {
      return {
        kind: scope.kind,
        reason: scope.reason.replace("คำสั่ง", "สคริปต์"),
        impact: scope.impact,
      };
    }
    return undefined;
  },
  async execute(args, ctx) {
    const { script, file_name } = args;
    if (!script) {
      return { output: "Error: script is required", exitCode: 1 };
    }

    const files: string[] = [];

    // Random delimiter: a fixed one could appear inside the (LLM-generated)
    // script and terminate the heredoc early, executing the rest as shell.
    const delimiter = `PY_EOF_${crypto.randomBytes(8).toString("hex")}`;

    // Persist to disk as a side effect if requested (best-effort, don't block execution)
    if (file_name) {
      const safeName = file_name.replace(/^.*[\\/]/, "");
      if (safeName) {
        ctx.runCommand(
          `cat > './${safeName.replace(/'/g, "'\\''")}' << '${delimiter}'\n${script}\n${delimiter}`,
          10_000,
        ).catch(() => {});
        files.push(safeName);
      }
    }

    // Always run in-memory via stdin — faster and avoids path issues
    const { output, exitCode } = await ctx.runCommand(
      `python3 << '${delimiter}'\n${script}\n${delimiter}`,
      this.timeoutMs,
    );
    const suggestion = exitCode !== 0 ? await detectMissingModule(output, ctx.runCommand) : null;
    return { output, exitCode, ...(files.length ? { files } : {}), ...(suggestion ? { installSuggestion: suggestion } : {}) };
  },
};

export default runPythonScript;
