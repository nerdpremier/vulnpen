/**
 * Classification of a security finding against the OWASP Top 10:2025.
 *
 * One source, and one only: the CWE recorded on the finding, looked up in the
 * CWE lists OWASP publishes for the ten 2025 categories (see
 * `knowledge/owasp-cwe-index.ts`). Those ten lists are disjoint — every one of
 * the 249 CWEs appears under exactly one category — so the lookup is a
 * single-valued, deterministic function. There is nothing to break a tie with
 * and nothing to guess.
 *
 * There is deliberately no second layer:
 *   - OWASP publishes no WSTG-to-Top-10 mapping, so this project does not
 *     invent one (the WSTG case is recorded as methodology traceability only);
 *   - a category a model guessed is not a classification a client report can
 *     stand behind.
 *
 * A finding whose CWE is missing, unrecognisable, or absent from the published
 * lists is reported Unmapped together with the reason. "Unmapped" is a real
 * answer — it is what tells the tester which finding still needs a weakness id.
 */

import { getOwaspCategory, normalizeCwe, owaspCategoriesForCwe } from "../../knowledge";
import type { OwaspTop10Id } from "../../knowledge";

/** Only two outcomes exist: the official list answered, or it did not. */
export type OwaspMappingSource = "cwe" | "unmapped";

/**
 * Where a mapping decision came from. With a single official source this is
 * always "official" — the type is kept so a stored finding and a report can
 * state the basis explicitly rather than implying it.
 */
export type OwaspMappingProvenance = "official";

export interface OwaspMappingInput {
  /** The weakness id the finding is classified by. The only deciding input. */
  cwe?: string;
  /**
   * Accepted so a caller can hand over a whole finding record, and rendered in
   * explanations. None of these fields ever changes the category.
   */
  title?: string;
  description?: string;
  contextSummary?: string;
  evidence?: string;
  endpoint?: string;
  service?: string;
  wstgId?: string;
}

export interface OwaspMappingResult {
  primary?: OwaspTop10Id;
  primaryTitle?: string;
  source: OwaspMappingSource;
  /** Set with `primary`; always "official". */
  provenance?: OwaspMappingProvenance;
  rationale: string;
}

export function mapFindingToOwaspTop10(input: OwaspMappingInput): OwaspMappingResult {
  const cwe = normalizeCwe(input.cwe);

  if (!cwe) {
    return {
      source: "unmapped",
      rationale:
        "No CWE is recorded on this finding, so it cannot be classified from the official " +
        "OWASP Top 10:2025 CWE lists. Record the weakness id (data.cwe) and the category " +
        "follows deterministically.",
    };
  }

  const categories = owaspCategoriesForCwe(cwe);
  if (!categories.length) {
    return {
      source: "unmapped",
      rationale:
        `${cwe} is not in the CWE list OWASP publishes for any OWASP Top 10:2025 category, ` +
        "so this finding is left unmapped rather than forced into one.",
    };
  }

  const primary = categories[0];
  const category = getOwaspCategory(primary)!;
  return {
    primary,
    primaryTitle: category.title,
    source: "cwe",
    provenance: "official",
    rationale: `${cwe} is listed by the OWASP Top 10:2025 under ${primary} ${category.title}.`,
  };
}

export function describeOwaspMapping(result: OwaspMappingResult): string {
  if (!result.primary) {
    return `Unmapped to the OWASP Top 10:2025. ${result.rationale}`;
  }
  return `${result.primary} ${result.primaryTitle ?? ""} — official (${result.source}): ${result.rationale}`;
}

export { normalizeCwe };
