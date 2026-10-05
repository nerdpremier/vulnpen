import { ShellManager } from "./shell.manager";
import type { BoxEnvInfo } from "../utils/assistant/prompts";

// ─── Box env probe ─────────────────────────────────────────────────────
// The attack-box facts the system prompt's env section renders (user, home,
// OS, workspace path), detected once at the start of an agent run. The
// round-trip command, the delimiter parse, and the ~/ workspace resolution
// live here — the agent loop only learns "probe when connected, skip when
// not".

/**
 * Probes the attack box over the session's shell manager. Returns undefined
 * when the shell is not connected, the output is unparseable, or the probe
 * fails — the prompt then renders without an env section.
 */
export async function probeBoxEnv(
  shellManager: ShellManager,
): Promise<BoxEnvInfo | undefined> {
  if (!shellManager.isConnected) return undefined;
  try {
    // One round-trip; ||| survives whitespace in $HOME.
    const { output } = await shellManager.execInShell(
      `echo "$USER|||$HOME|||$(uname -s)|||$(uname -m)"`,
      10_000,
    );
    const parts = output.trim().split("|||");
    if (parts.length < 4) return undefined;
    const home = parts[1];
    return {
      user: parts[0],
      home,
      os: `${parts[2]} (${parts[3]})`,
      // remoteWorkspaceDir can be "~"-relative; anchor it to the probed home.
      workspacePath: shellManager.remoteWorkspaceDir.replace(/^~/, home),
    };
  } catch (err: any) {
    console.warn(`[box-env] Probe failed: ${err.message}`);
    return undefined;
  }
}
