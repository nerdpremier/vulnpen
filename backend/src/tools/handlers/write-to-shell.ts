import { ToolDefinition } from "../types";

/**
 * Shells spawned by VulnPen always live on the attack box (spawn_shell only
 * accepts the "exploit-box" purpose), so there is no remote input to gate.
 * The engagement boundary for what the agent reaches is enforced where commands
 * and scripts run — see shellSafetyDetail / scriptSafetyDetail.
 */
const writeToShell: ToolDefinition = {
  name: "write_to_shell",
  description:
    "Send input to an existing persistent shell on the attack box. Use this for " +
    "interactive programs, responding to prompts, long-running processes, or any " +
    "scenario where you need to type into a running shell.",
  parameters: {
    type: "object",
    properties: {
      shell_id: {
        type: "string",
        description: "The shell_id to write to (from spawn_shell)",
      },
      input: {
        type: "string",
        description: "The text to send to the shell. Include \\n for Enter key.",
      },
    },
    required: ["shell_id", "input"],
  },
  timeoutMs: 30_000,
  async execute(args, ctx) {
    const { shell_id, input } = args;
    if (!shell_id) return { output: "Error: shell_id is required", exitCode: 1 };
    if (input === undefined) return { output: "Error: input is required", exitCode: 1 };

    try {
      await ctx.writeToShell(shell_id, input);
      await new Promise((r) => setTimeout(r, 300));
      const { data } = await ctx.readShellOutput(shell_id);
      // "\n" — a real newline. Written as "\\n" this split matched nothing,
      // so the "last 30 lines" cap never applied and the reply printed literal
      // backslash-n instead of line breaks (read_shell always used "\n").
      const lastLines = data.split("\n").slice(-30).join("\n");
      return {
        output: `Input sent to shell ${shell_id}. Recent output:\n${lastLines}`,
        exitCode: 0,
      };
    } catch (err: any) {
      return { output: `Failed to write to shell: ${err.message}`, exitCode: 1 };
    }
  },
};

export default writeToShell;