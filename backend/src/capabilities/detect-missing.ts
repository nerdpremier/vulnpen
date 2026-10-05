import { findCapabilityForCommand } from "./registry";

export type RunCommand = (
  cmd: string,
  timeoutMs?: number,
) => Promise<{ output: string; exitCode: number }>;

export interface InstallSuggestion {
  name: string;
  label: string;
  installCommand: string;
  size: string;
}

/** Python interpreter messages: a missing module, not a missing binary. */
export const MODULE_NOT_FOUND_PATTERNS = [
  /No module named ['"]*(\S+?)['"]*\s*$/im,
  /ModuleNotFoundError: No module named ['"]*(\S+?)['"]*$/im,
  /ImportError: No module named ['"]*(\S+?)['"]*$/im,
];

/** Shell messages: missing binary, plus the python module forms because a
 *  bash command may run python inline (e.g. `python3 -c ...`). */
export const BASH_NOT_FOUND_PATTERNS = [
  /(\S+): (?:command )?not found/i,
  /bash: (\S+): No such file or directory/i,
  ...MODULE_NOT_FOUND_PATTERNS,
];

/**
 * The patterns only read the output text — a `curl --fail` against a 404 page
 * looks exactly like a missing tool. Confirm the capability is genuinely
 * absent with its own check before offering an install.
 */
export async function isGenuinelyMissing(
  cap: { name: string; checkCommand?: string },
  runCommand: RunCommand,
): Promise<boolean> {
  if (!cap.checkCommand) return true;
  const probe = await runCommand(`{ ${cap.checkCommand}; } >/dev/null 2>&1`, 10_000);
  return probe.exitCode !== 0;
}

/**
 * Map a tool's failure output onto an installable capability, if the failure
 * really is "this tool is missing". `command` enables the first-word
 * heuristic for bare "not found" output; pass narrower `patterns` to restrict
 * what counts as a miss (run_python_script passes only the module patterns).
 */
export async function detectMissingCapability(
  output: string,
  command: string | undefined,
  runCommand: RunCommand,
  patterns: RegExp[] = BASH_NOT_FOUND_PATTERNS,
): Promise<InstallSuggestion | null> {
  const suggest = async (missingName: string): Promise<InstallSuggestion | null> => {
    const cap = findCapabilityForCommand(missingName);
    if (cap && (await isGenuinelyMissing(cap, runCommand))) {
      return { name: cap.name, label: cap.label, installCommand: cap.installCommand, size: cap.size };
    }
    return null;
  };

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      const suggestion = await suggest(match[1]);
      if (suggestion) return suggestion;
    }
  }

  if (command && output.includes("not found")) {
    const firstWord = command.trim().split(/\s+/)[0];
    if (firstWord) {
      const suggestion = await suggest(firstWord);
      if (suggestion) return suggestion;
    }
  }

  return null;
}
