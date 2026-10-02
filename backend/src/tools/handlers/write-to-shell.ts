import { ExecutionContext, ToolDefinition } from "../types";
import {
  remoteShellInputSafetyDetail,
  shellInputSafetyDetail,
} from "../../utils/consentDetail";

/**
 * A shell whose prompt lives on the target (a reverse shell, a caught bind
 * listener, a session on the compromised host) is checked with the target rules;
 * a shell on the attack box is checked with the attack-box rules. Both are gated
 * - an autonomous agent holding a shell on the client's machine is exactly where
 * a silent `rm -rf` does the most damage, and it used to be the one place nothing
 * was checked at all.
 */
function shellBoundary(
  args: Record<string, any>,
  ctx: ExecutionContext,
): ReturnType<typeof shellInputSafetyDetail> {
  const shellInfo = ctx.getShellInfo(args.shell_id);
  const onTarget =
    !shellInfo ||
    shellInfo.purpose === "reverse-shell" ||
    shellInfo.purpose === "listener";
  return onTarget
    ? remoteShellInputSafetyDetail(args.input ?? "", ctx)
    : shellInputSafetyDetail(args.input ?? "", ctx);
}

const writeToShell: ToolDefinition = {
  name: "write_to_shell",
  description:
    "Send input to an existing persistent shell. Use this for interactive programs, " +
    "sending commands to a reverse shell caught by netcat, responding to prompts, " +
    "or any scenario where you need to type into a running shell. " +
    "Commands typed into a shell on the target are still bound by the engagement rules: " +
    "never delete, overwrite or disable data, accounts or configuration on the target.",
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
  shouldRequireConsent(args, ctx) {
    return shellBoundary(args, ctx) !== undefined;
  },
  describeSafety(args, ctx) {
    return shellBoundary(args, ctx);
  },
  async execute(args, ctx) {
    const { shell_id, input } = args;
    if (!shell_id) return { output: "Error: shell_id is required", exitCode: 1 };
    if (input === undefined) return { output: "Error: input is required", exitCode: 1 };

    try {
      await ctx.writeToShell(shell_id, input);
      await new Promise((r) => setTimeout(r, 300));
      const { data } = await ctx.readShellOutput(shell_id);
      const lastLines = data.split("\\n").slice(-30).join("\\n");
      return {
        output: `Input sent to shell ${shell_id}. Recent output:\\n${lastLines}`,
        exitCode: 0,
      };
    } catch (err: any) {
      return { output: `Failed to write to shell: ${err.message}`, exitCode: 1 };
    }
  },
};

export default writeToShell;