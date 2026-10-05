import { readEnvFile } from "./envWriter";
import { BROWSER_TOOL_NAMES, BURP_TOOL_NAMES } from "../tools/names";

/**
 * Returns tool names that are NOT configured (missing required env/settings).
 * These tools should be excluded from the LLM context and greyed out in the UI.
 */
export function getUnconfiguredToolNames(): string[] {
  const env = readEnvFile();
  const unconfigured: string[] = [];

  const burpConfigured = !!env.BURP_RPC_HOST;
  if (!burpConfigured) {
    unconfigured.push(...BURP_TOOL_NAMES);
  }

  const magnitudeConfigured = env.MAGNITUDE_ENABLED === "true";
  if (!magnitudeConfigured) {
    unconfigured.push(...BROWSER_TOOL_NAMES);
  }

  return unconfigured;
}
