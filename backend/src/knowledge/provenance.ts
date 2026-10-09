/**
 * Provenance for the reference data in this folder.
 *
 * Two official sources feed the product, and nothing else does:
 *
 *   1. the OWASP Top 10:2025 category pages, whose "List of Mapped CWEs"
 *      sections are the one published relation between a weakness and a
 *      category; and
 *   2. the OWASP Web Security Testing Guide v4.2, whose test cases are the
 *      methodology the engagement is planned and reported against.
 *
 * Neither source publishes a mapping from a WSTG test case to a CWE or to the
 * Top 10. This project therefore does not carry one: a finding is classified by
 * the CWE recorded on it, looked up in source 1. The constants below exist so a
 * report can state where its facts came from.
 */

export const OWASP_TOP10_2025_CWE_PROVENANCE = {
  kind: "official" as const,
  source:
    "OWASP Top 10:2025 — the 'List of Mapped CWEs' section of each Axx:2025 category page",
  url: "https://owasp.org/Top10/2025/",
  repository: "https://github.com/OWASP/Top10 (2025/docs/en/)",
  retrieved: "2026-10-09",
  note:
    "The ten lists are disjoint: every one of the 249 CWEs appears under exactly one category, so CWE -> category is single-valued. Pinned by tests/catalogConformance.test.ts.",
};

export const WSTG_V42_CATALOGUE_PROVENANCE = {
  kind: "official" as const,
  source: "OWASP Web Security Testing Guide v4.2 — the test case catalogue",
  url: "https://owasp.org/www-project-web-security-testing-guide/v42/",
  repository: "https://github.com/OWASP/wstg (tag v4.2, checklist/checklist.json)",
  retrieved: "2026-10-09",
  note:
    "Ids, sections and titles are the published v4.2 facts. The WSTG publishes no CWE or Top 10 mapping for a test case, so none is attached to one here.",
};
