// The capability install/detect protocol, owned here so no controller runs
// shell commands or writes the user's installedCapabilities list by hand.
// The registry (capabilities/) owns the data — commands, detection script,
// output parsing; this service owns the execution and the stamp.

import type { UserDoc } from "../models/User/User.model";
import {
  allCapabilities,
  buildDetectionScript,
  getCapabilityByName,
  getInstallCommandForOS,
  parseDetectionOutput,
} from "../capabilities/registry";
import { buildPrivilegeAwareInstallCommand } from "../utils/installCommand";
import { execSSHCommand } from "./ssh.service";
import { sessionLifecycle } from "./session.lifecycle";

export class CapabilityError extends Error {}

/**
 * Install a capability on the session's attack box: probe the OS, build the
 * privilege-aware install command, guard the apt dependency, run it, and stamp
 * the user's installedCapabilities on success. Throws CapabilityError with an
 * operator-facing message when the capability is unknown or the host cannot
 * run the installer.
 */
export async function installCapability(
  sessionId: string,
  capabilityName: string,
  user: UserDoc,
): Promise<{ success: boolean; output: string; exitCode: number; message: string; capability: { name: string; label: string } }> {
  const cap = getCapabilityByName(capabilityName);
  if (!cap) {
    throw new CapabilityError(`Unknown capability: "${capabilityName}"`);
  }

  const shellManager = await sessionLifecycle.ensureShellManager(sessionId, {
    required: true,
  });

  const { output: unameOutput } = await shellManager.execInShell("uname -s", 5_000);
  const isDarwin = unameOutput.trim().includes("Darwin");
  const installCommand = buildPrivilegeAwareInstallCommand(
    getInstallCommandForOS(cap, isDarwin),
    isDarwin,
  );
  if (!isDarwin && /(^|\s)(apt|apt-get)(\s|$)/.test(installCommand)) {
    const { exitCode: aptExitCode } = await shellManager.execInShell(
      "command -v apt-get",
      5_000,
    );
    if (aptExitCode !== 0) {
      throw new CapabilityError(
        `Automatic installation of ${cap.label} requires a Debian/Ubuntu/Kali work host with apt-get. Install it manually on this host and run capability detection again.`,
      );
    }
  }
  const { output, exitCode } = await shellManager.execInShell(installCommand, 600_000);

  if (exitCode === 0) {
    const installed = new Set(user.configs.installedCapabilities ?? []);
    installed.add(cap.name);
    user.configs.installedCapabilities = Array.from(installed);
    await user.save();
  }

  return {
    success: exitCode === 0,
    output,
    exitCode,
    message:
      exitCode === 0
        ? `${cap.label} installed successfully`
        : output.trim() || `${cap.label} installation exited with code ${exitCode}`,
    capability: { name: cap.name, label: cap.label },
  };
}

/**
 * Detect which of the user's selected capabilities are present on the SSH
 * box: run the registry's detection script, parse it, and record the result
 * as the user's installedCapabilities.
 */
export async function detectCapabilities(
  user: UserDoc,
): Promise<{ installedCapabilities: string[]; detectionResults: Record<string, boolean> }> {
  const selected: string[] =
    user.configs.capabilities ?? allCapabilities.map((c) => c.name);

  const script = buildDetectionScript(selected);
  const output = await execSSHCommand(script);
  const results = parseDetectionOutput(output);

  user.configs.installedCapabilities = Object.entries(results)
    .filter(([, isInstalled]) => isInstalled)
    .map(([name]) => name);
  await user.save();

  return { installedCapabilities: user.configs.installedCapabilities, detectionResults: results };
}
