export const DEFAULT_MAX_AGENT_ITERATIONS = 80;
export const MIN_MAX_AGENT_ITERATIONS = 5;
export const MAX_MAX_AGENT_ITERATIONS = 500;

/**
 * A run's turn ceiling. A stored value that was clamped down (the schema used to
 * cap at 200 while this module advertised 500) is restored on read rather than
 * silently honoured, so raising a limit here actually raises the ceiling.
 */
export function normalizeMaxAgentIterations(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_AGENT_ITERATIONS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_AGENT_ITERATIONS;
  return Math.min(
    MAX_MAX_AGENT_ITERATIONS,
    Math.max(MIN_MAX_AGENT_ITERATIONS, Math.round(parsed)),
  );
}
