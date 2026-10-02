/**
 * Provenance for the reference data in this folder.
 *
 * The OWASP facts (category ids, titles and the per-category CWE lists) are
 * transcribed from the official sources and must stay identical to them: the
 * conformance test in tests/catalogConformance.test.ts fails if they drift.
 *
 * The WSTG -> OWASP Top 10 crosswalk is NOT published by OWASP. It is a curated
 * mapping maintained by this project, derived from the CWE lists OWASP publishes
 * for each category, and it is labelled as curated everywhere it is used so a
 * report never claims OWASP authorship it does not have.
 */

export const OWASP_TOP10_2025_CWE_PROVENANCE = {
  kind: "official" as const,
  source: "OWASP Top 10:2025 - the List of Mapped CWEs section of each Axx:2025 page",
  url: "https://owasp.org/Top10/2025/",
  retrieved: "2026-10-02",
};



export const WSTG_OWASP_CROSSWALK_PROVENANCE = {
  kind: "curated" as const,
  curatedBy: "VulnPen (T-NET IT Solution)",
  basis:
    "Crosswalk derived from the CWE identifiers OWASP publishes for each Top 10:2025 category. OWASP does not publish a machine-readable WSTG-to-Top-10 mapping.",
  version: "1.0",
  updated: "2026-10-02",
  note:
    "Labelled curated wherever a mapping rationale is shown, so the report never implies OWASP authorship.",
};