/**
 * The likelihood x impact risk matrix, the method the WSTG Reporting guidance
 * asks for (it requires likelihood/exploitability, impact and a risk rating,
 * and the vocabulary is Informational, Low, Medium and High). Likelihood and
 * impact are recorded on a three-point scale, 1 = low, 2 = medium, 3 = high,
 * carry equal weight, and are combined as:
 *
 *   likelihood \ impact | low    | medium | high
 *   high                | low    | medium | high
 *   medium              | low    | medium | medium
 *   low                 | low    | low    | low
 *
 * The full table is printed in the report so a reader can reproduce it.
 * Reference data only: no I/O.
 */
export function wstgRiskRating(
  likelihood?: number,
  impactRating?: number,
): "high" | "medium" | "low" | undefined {
  if (likelihood == null || impactRating == null) return undefined;
  const l = Math.min(3, Math.max(1, Math.round(likelihood)));
  const i = Math.min(3, Math.max(1, Math.round(impactRating)));
  if (l >= 3) return i >= 3 ? "high" : i >= 2 ? "medium" : "low";
  if (l === 2) return i >= 2 ? "medium" : "low";
  return "low";
}
