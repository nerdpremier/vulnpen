import { toolRegistry } from "../tools/registry";

/**
 * Returns tool names that are NOT ready (their external dependency — env
 * settings, assigned model, API key — is missing). Derived from the registry:
 * every tool that can be unavailable declares checkReady on its own
 * definition, so "is this tool configured" has one source of truth instead of
 * a parallel name list. Unready tools are excluded from the LLM context,
 * greyed out in the UI, and refused by the run path with the same check.
 */
export async function getUnconfiguredToolNames(): Promise<string[]> {
  const unconfigured: string[] = [];
  for (const tool of toolRegistry.getAll()) {
    if (!tool.checkReady) continue;
    try {
      if (await tool.checkReady()) unconfigured.push(tool.name);
    } catch {
      // A readiness probe that blows up is as good as an unconfigured tool:
      // the model must not be offered something that cannot run.
      unconfigured.push(tool.name);
    }
  }
  return unconfigured;
}
