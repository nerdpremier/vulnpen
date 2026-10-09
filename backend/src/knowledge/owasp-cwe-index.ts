/**
 * The one official bridge between a weakness and the OWASP Top 10:2025.
 *
 * OWASP publishes exactly one machine-usable relation between a weakness and a
 * Top 10:2025 category: the "List of Mapped CWEs" section of each category page
 * on https://owasp.org/Top10/2025/ (mirrored in the OWASP/Top10 repository under
 * `2025/docs/en/Axx_2025-*.md`). This module turns those lists into the single
 * lookup every mapper, report and tool reads.
 *
 * What OWASP does NOT publish — and what therefore must never be presented as
 * official:
 *   - a WSTG test case -> CWE mapping (the WSTG v4.2 test documents carry no CWE
 *     identifiers at all; the official `checklists/checklist.json` has only
 *     name/id/reference/objectives), and
 *   - a WSTG test case -> Top 10 mapping.
 *
 * The WSTG catalogue in `wstg-v42.ts` carries no classification at all — OWASP
 * publishes no WSTG-to-CWE and no WSTG-to-Top-10 relation, so none is invented
 * here. This file is the only place a mapping may be labelled `official`.
 */

import { OWASP_TOP10_2025 } from "./owasp-top10-2025";
import type { OwaspTop10Id } from "./types";

/**
 * Accepts "CWE-89", "89", "cwe 89", "CWE_89" and returns the canonical
 * "CWE-89". Anything that carries no digits is returned trimmed and upper-cased
 * so an unrecognisable value still compares equal to itself.
 */
export function normalizeCwe(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().toUpperCase();
  if (!raw) return "";
  if (/^CWE-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CWE-${raw}`;
  const bare = raw.match(/CWE[-_ ]?(\d+)/);
  return bare ? `CWE-${bare[1]}` : raw;
}

/**
 * CWE -> the Top 10:2025 categories whose published list contains it, in
 * catalogue order (A01 first). Built once from the official data, so it cannot
 * disagree with `OWASP_TOP10_2025`.
 */
const CWE_INDEX: ReadonlyMap<string, readonly OwaspTop10Id[]> = (() => {
  const index = new Map<string, OwaspTop10Id[]>();
  for (const category of OWASP_TOP10_2025) {
    for (const cwe of category.cwes) {
      const key = normalizeCwe(cwe);
      if (!key) continue;
      const current = index.get(key);
      if (!current) {
        index.set(key, [category.id]);
      } else if (!current.includes(category.id)) {
        current.push(category.id);
      }
    }
  }
  return index;
})();

/** The categories the official OWASP list assigns to this CWE ([] when none). */
export function owaspCategoriesForCwe(value: unknown): readonly OwaspTop10Id[] {
  const key = normalizeCwe(value);
  return key ? CWE_INDEX.get(key) ?? [] : [];
}

/** Whether the official OWASP Top 10:2025 lists contain this CWE at all. */
export function isMappedCwe(value: unknown): boolean {
  return owaspCategoriesForCwe(value).length > 0;
}

/** Every CWE the official 2025 lists contain (249 across the ten categories). */
export function allMappedCwes(): string[] {
  return Array.from(CWE_INDEX.keys());
}
