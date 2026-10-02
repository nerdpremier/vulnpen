import { ToolDefinition } from "../types";
import {
  getCapabilityByName,
  getInstallCommandForOS,
} from "../../capabilities/registry";
import { buildPrivilegeAwareInstallCommand } from "../../utils/installCommand";

const runInstallTool: ToolDefinition = {
  name: "run_install_tool",
  description:
    "Install a capability on the attack box by name. " +
    "Pass the tool/package name exactly as listed in the capabilities section (e.g. 'nmap', 'pwntools', 'ghidra'). " +
    "The system resolves the correct install command automatically (brew on macOS, apt on Linux). " +
    "This tool requires user consent before execution.",
  parameters: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description:
          "The capability name to install, as listed in the system prompt " +
          "(e.g. 'nmap', 'pwntools', 'sqlmap', 'ghidra')",
      },
    },
    required: ["tool_name"],
  },
  requiresConsent: true,
  describeSafety(args) {
    return {
      kind: "dangerous",
      reason: `ติดตั้งเครื่องมือใหม่ (${args.tool_name ?? "ไม่ทราบชื่อ"}) ลงเครื่องทดสอบ`,
      impact: "เพิ่มซอฟต์แวร์ใหม่และใช้พื้นที่ดิสก์บนเครื่องทดสอบ",
    };
  },
  timeoutMs: 600_000,
  async execute(args, ctx) {
    const toolName = args.tool_name;
    if (!toolName) return { output: "Error: no tool_name provided", exitCode: 1 };

    const cap = getCapabilityByName(toolName);
    if (!cap) {
      return {
        output: `Unknown capability: "${toolName}". Use the exact name from the capabilities list.`,
        exitCode: 1,
      };
    }

    // Detect OS so we use brew on macOS and apt on Linux
    let isDarwin = false;
    try {
      const { output: unameOut } = await ctx.runCommand("uname -s", 5_000);
      isDarwin = unameOut.trim().includes("Darwin");
    } catch {
      // Assume Linux if detection fails (e.g. SSH disconnected)
    }

    const installCmd = buildPrivilegeAwareInstallCommand(
      getInstallCommandForOS(cap, isDarwin),
      isDarwin,
    );

    if (isDarwin && /(^|&&\s*)brew\s/.test(installCmd)) {
      const { exitCode: brewCheck } = await ctx.runCommand("command -v brew", 5_000);
      if (brewCheck !== 0) {
        return {
          output:
            `Homebrew is required to install "${toolName}" on macOS but was not found on PATH.\n` +
            `Install it with:\n` +
            `  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n` +
            `Then re-run this install.`,
          exitCode: 127,
        };
      }
    }

    if (!isDarwin && /(^|\s)(apt|apt-get)(\s|$)/.test(installCmd)) {
      const { exitCode: aptCheck } = await ctx.runCommand("command -v apt-get", 5_000);
      if (aptCheck !== 0) {
        return {
          output:
            `Automatic installation of "${toolName}" requires a Debian/Ubuntu/Kali work host with apt-get. ` +
            "Install it manually on this host, then run capability detection again.",
          exitCode: 127,
        };
      }
    }

    const { output, exitCode } = await ctx.runCommand(installCmd, this.timeoutMs);
    return { output, exitCode };
  },
};

export default runInstallTool;
