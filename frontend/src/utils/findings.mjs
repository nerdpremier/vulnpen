/**
 * Pure helpers for reading vulnerability (finding) lists.
 *
 * The severity vocabulary is fixed by the backend report contract
 * (`critical | high | medium | low | info`), so it lives here once instead of
 * as a literal object inside one page. Ordering matters: every surface that
 * lists severities — the overview, the findings table, the report — must put
 * critical first, and an unknown severity must never sort above a known one.
 */

export const SEVERITY_LEVELS = [
  { key: "critical", label: "Critical" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "info", label: "Info" },
];

const RANK = new Map(SEVERITY_LEVELS.map((level, index) => [level.key, index]));

/** Rank of a severity, highest first. Unknown values sort last. */
export function severityRank(severity) {
  const rank = RANK.get(String(severity ?? "").toLowerCase());
  return rank === undefined ? SEVERITY_LEVELS.length : rank;
}

/** Newest-first comparison for two findings by severity. */
export function compareBySeverity(a, b) {
  return severityRank(a?.severity) - severityRank(b?.severity);
}

/**
 * The headline numbers of a findings list: how many, and how many at each
 * severity. Levels with no findings are kept so a surface can render a stable
 * scale instead of reflowing as counts appear.
 */
export function findingsBySeverity(vulnerabilities) {
  const findings = vulnerabilities ?? [];
  const counts = new Map();
  for (const finding of findings) {
    const key = String(finding?.severity ?? "").toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    total: findings.length,
    levels: SEVERITY_LEVELS.map((level) => ({
      ...level,
      count: counts.get(level.key) ?? 0,
    })),
    /** Highest-severity first; the caller decides how many to show. */
    ranked: [...findings].sort(compareBySeverity),
  };
}
