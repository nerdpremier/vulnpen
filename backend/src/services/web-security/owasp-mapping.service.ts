/**
 * Deterministic mapping of security findings to the OWASP Top 10:2025.
 *
 * The agent is asked to classify findings as it reports them, but models drift
 * and forget. This service gives the assistant (and the REST API, and the
 * report builder) one reproducible answer: an explicit tester mapping wins,
 * then the OWASP categories attached to the WSTG v4.2 test case that produced
 * the finding, then the CWE list OWASP publishes for each category. Anything
 * else is left to the LLM classifier (owasp-llm-classifier.ts) or returned
 * "unmapped" rather than guessed — the caller is told what to add.
 */

import {
  OWASP_TOP10_2025,
  allWstgTestIds,
  getOwaspCategory,
  getWstgTest,
  normalizeOwaspTop10Id,
} from "../../knowledge";
import type { OwaspTop10Id } from "../../knowledge";
import { WSTG_OWASP_CROSSWALK_PROVENANCE } from "../../knowledge/provenance";

/**
 * Where a mapping decision came from, so a report can be honest about it:
 * - official: the CWE list OWASP publishes for a Top 10:2025 category
 * - curated:  this project's WSTG -> Top 10 crosswalk (OWASP publishes no such mapping)
 * - tester:   an explicit human/agent decision recorded on the finding
 * - model:    the LLM fallback classifier
 */
export type OwaspMappingProvenance = "official" | "curated" | "tester" | "model";

export type OwaspMappingSource =
  | "explicit"
  | "wstg"
  | "cwe"
  | "llm"
  | "unmapped";

export type OwaspMappingConfidence = "high" | "medium" | "low";

export interface OwaspMappingInput {
  title?: string;
  description?: string;
  contextSummary?: string;
  evidence?: string;
  endpoint?: string;
  service?: string;
  tags?: string[];
  cwe?: string;
  wstgId?: string;
  /** An explicit classification already chosen by the tester or the agent. */
  owaspTop10?: string;
}

export interface OwaspMappingResult {
  primary?: OwaspTop10Id;
  primaryTitle?: string;
  related: OwaspTop10Id[];
  wstgIds: string[];
  confidence: OwaspMappingConfidence;
  source: OwaspMappingSource;
  rationale: string;
  /** Set when a source points at several categories and refuses to guess. */
  ambiguous?: OwaspTop10Id[];
  /** Where the mapping decision came from (honesty for the report). */
  provenance?: OwaspMappingProvenance;
}

const CWE_INDEX: ReadonlyMap<string, OwaspTop10Id[]> = (() => {
  const index = new Map<string, OwaspTop10Id[]>();
  for (const category of OWASP_TOP10_2025) {
    for (const cwe of category.cwes) {
      const key = normalizeCwe(cwe);
      if (!key) continue;
      const current = index.get(key) ?? [];
      if (!current.includes(category.id)) current.push(category.id);
      index.set(key, current);
    }
  }
  return index;
})();


export function normalizeCwe(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().toUpperCase();
  if (!raw) return "";
  if (/^CWE-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CWE-${raw}`;
  const bare = raw.match(/CWE[-_ ]?(\d+)/);
  return bare ? `CWE-${bare[1]}` : raw;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function byRank(ids: OwaspTop10Id[]): OwaspTop10Id[] {
  return unique(ids).sort((a, b) => a.localeCompare(b));
}

function primaryCategoryForLexicon(
  cwe: string,
): { primary: OwaspTop10Id; all: OwaspTop10Id[] } | undefined {
  const key = normalizeCwe(cwe);
  if (!key) return undefined;
  const categories = CWE_INDEX.get(key);
  if (!categories?.length) return undefined;
  return { primary: categories[0], all: categories };
}

export function mapFindingToOwaspTop10(
  input: OwaspMappingInput,
): OwaspMappingResult {
  const wstg = getWstgTest(input.wstgId);
  const explicit = normalizeOwaspTop10Id(input.owaspTop10);

  if (explicit) {
    const category = getOwaspCategory(explicit)!;
    return {
      primary: explicit,
      primaryTitle: category.title,
      related: byRank(wstg?.owasp ?? []).filter((id) => id !== explicit),
      wstgIds: wstg ? [wstg.id] : [],
      confidence: "high",
      source: "explicit",
      provenance: "tester",
      rationale:
        `Classified as ${explicit} ${category.title} from the tester's explicit mapping` +
        (wstg ? ` on test case ${wstg.id} (${wstg.title})` : "") +
        ".",
    };
  }

  if (wstg) {
    const [primary, ...related] = wstg.owasp;
    const category = getOwaspCategory(primary)!;
    return {
      primary,
      primaryTitle: category.title,
      related: byRank(related),
      wstgIds: [wstg.id],
      confidence: "high",
      source: "wstg",
      provenance: "curated",
      rationale:
        `Test case ${wstg.id} (${wstg.title}) targets ${category.id} ${category.title}` +
        ` via this project's curated WSTG-to-Top-10 crosswalk (v${WSTG_OWASP_CROSSWALK_PROVENANCE.version}) - ` +
        "OWASP does not publish a WSTG-to-Top-10 mapping, so treat it as a curated starting point, not an OWASP verdict.",
    };
  }

  const lexicon = primaryCategoryForLexicon(input.cwe ?? "");
  if (lexicon) {
    // One candidate category is a deterministic answer. Several candidates are
    // NOT guessable from the CWE alone — the LLM classifier (or a human) picks
    // among the candidates, so report them instead of silently taking the first.
    if (lexicon.all.length === 1) {
      const category = getOwaspCategory(lexicon.primary)!;
      return {
        primary: lexicon.primary,
        primaryTitle: category.title,
        related: byRank(lexicon.all.filter((id) => id !== lexicon.primary)),
        wstgIds: [],
        confidence: "high",
        source: "cwe",
        provenance: "official",
        rationale:
          `${normalizeCwe(input.cwe)} is listed by the OWASP Top 10:2025 under ` +
          `${lexicon.primary} ${category.title}.`,
      };
    }
    return {
      related: [],
      wstgIds: [],
      confidence: "low",
      source: "unmapped",
      ambiguous: lexicon.all,
      rationale:
        `${normalizeCwe(input.cwe)} is listed by the OWASP Top 10:2025 under several ` +
        `categories (${lexicon.all.join(", ")}), so this finding needs a decision from the ` +
        "LLM classifier or a tester rather than a default pick.",
    };
  }

  return {
    related: [],
    wstgIds: [],
    confidence: "low",
    source: "unmapped",
    rationale:
      "No explicit OWASP category, WSTG test case or CWE was supplied, so this finding is " +
      "left unmapped for the LLM classifier or a tester. Add a CWE, WSTG test id or an " +
      "explicit OWASP Top 10:2025 category to classify it deterministically.",
  };
}

export function describeOwaspMapping(result: OwaspMappingResult): string {
  if (!result.primary) {
    return `Unmapped to the OWASP Top 10:2025. ${result.rationale}`;
  }
  const related = result.related.length ? ` (related: ${result.related.join(", ")})` : "";
  return `${result.primary} ${result.primaryTitle ?? ""}${related} — ${result.confidence} confidence via ${result.source}: ${result.rationale}`;
}

export function suggestWstgTestsForFinding(input: OwaspMappingInput): string[] {
  const titleTokens = new Set(
    (input.title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
  const fromTitle = allWstgTestIds()
    .map((id) => getWstgTest(id))
    .filter((test) => {
      if (!test) return false;
      return test.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((w) => w.length >= 4 && titleTokens.has(w));
    })
    .map((test) => test!.id);
  const fromCwe = primaryCategoryForLexicon(input.cwe ?? "");
  const fromCategory = fromCwe
    ? getOwaspCategory(fromCwe.primary)?.wstgFocus ?? []
    : [];
  return unique([...fromTitle, ...fromCategory]).slice(0, 8);
}