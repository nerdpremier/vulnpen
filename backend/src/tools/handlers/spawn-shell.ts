import { ToolDefinition } from "../types";

const spawnShell: ToolDefinition = {
  name: "spawn_shell",
  description:
    "Create a new persistent named shell on the attack box; returns a shell_id for " +
    "write_to_shell and read_shell. For long-running processes and interactive sessions. " +
    "run_bash always runs a one-off command and does not take a shell_id.",
  parameters: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "Short label, e.g. 'nmap-scan', 'curl-loop-4444'.",
      },
      purpose: {
        type: "string",
        enum: ["exploit-box"],
        description: "'exploit-box' (default) for attack-box commands. This is the only supported purpose.",
      },
      rows: {
        type: "number",
        description: "Terminal rows (default 50).",
      },
      cols: {
        type: "number",
        description: "Terminal columns (default 200).",
      },
    },
    required: ["label"],
  },
  timeoutMs: 30_000,
  async execute(args, ctx) {
    const label = args.label;
    if (!label) return { output: "Error: label is required", exitCode: 1 };

    const purpose = args.purpose || "exploit-box";
    // The only purpose is "exploit-box". A request for a shell on the target
    // (an old reverse-shell/listener purpose value) is refused outright rather
    // than silently downgraded: the model must not get a shell whose input is
    // not the attack box it was told it was given.
    if (purpose !== "exploit-box") {
      return {
        output:
          `Purpose "${purpose}" is not supported: only "exploit-box" shells ` +
          "(on the attack box) exist. Restart the session from the attack box if a " +
          "target shell appears to be needed.",
        exitCode: 1,
      };
    }

    try {
      const shellId = await ctx.spawnShell(label, "pty", purpose);

      const rows = args.rows ? Math.max(1, Math.min(args.rows, 500)) : undefined;
      const cols = args.cols ? Math.max(1, Math.min(args.cols, 500)) : undefined;
      if (rows || cols) {
        ctx.resizeShell(shellId, cols || 200, rows || 50);
      }

      const sizeInfo = (rows || cols)
        ? `\nterminal size: ${cols || 200}x${rows || 50}`
        : "";

      return {
        output: `Shell spawned successfully.\nshell_id: ${shellId}\nlabel: ${label}\npurpose: ${purpose}${sizeInfo}\n\nYou can now use this shell_id with write_to_shell and read_shell.`,
        exitCode: 0,
      };
    } catch (err: any) {
      return { output: `Failed to spawn shell: ${err.message}`, exitCode: 1 };
    }
  },
};

export default spawnShell;
