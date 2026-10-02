/**
 * Lookup helpers over the static OWASP knowledge base.
 *
 * Everything here is pure and synchronous: the catalogs are compile-time data,
 * so the agent prompt, tools, REST API and report builder all read the same
 * single source of truth about WSTG v4.2 and the OWASP Top 10:2025.
 */

import {
  OWASP_TOP10_2025,
  OWASP_TOP10_2025_CWE_SOURCE,
  OWASP_TOP10_2025_CWES_RETRIEVED,
  OWASP_TOP10_2025_SOURCE,
  OWASP_TOP10_2025_VERSION,
} from "./owasp-top10-2025";
import type {
  OwaspTop10Category,
  OwaspTop10Id,
  WstgCategory,
  WstgTest,
} from "./types";
import { WSTG_CATEGORIES, WSTG_SOURCE, WSTG_TESTS, WSTG_VERSION } from "./wstg-v42";
import { wstgRiskRating } from "./risk-matrix";

export {
  OWASP_TOP10_2025,
  OWASP_TOP10_2025_CWE_SOURCE,
  OWASP_TOP10_2025_CWES_RETRIEVED,
  OWASP_TOP10_2025_SOURCE,
  OWASP_TOP10_2025_VERSION,
  WSTG_CATEGORIES,
  WSTG_SOURCE,
  WSTG_TESTS,
  WSTG_VERSION,
};
export { wstgRiskRating };
export type {
  OwaspTop10Category,
  OwaspTop10Id,
  WstgCategory,
  WstgCategoryCode,
  WstgTest,
  WstgTestStatus,
} from "./types";

const OWASP_ID_SET: ReadonlySet<string> = new Set(OWASP_TOP10_2025.map((c) => c.id));

const WSTG_TEST_BY_ID: ReadonlyMap<string, WstgTest> = new Map(
  WSTG_TESTS.map((test) => [test.id, test] as const),
);

const WSTG_TEST_BY_SECTION: ReadonlyMap<string, WstgTest> = new Map(
  WSTG_TESTS.map((test) => [test.section, test] as const),
);

const WSTG_TESTS_BY_CATEGORY: ReadonlyMap<string, WstgTest[]> = new Map(
  WSTG_CATEGORIES.map((category) => [
    category.code,
    WSTG_TESTS.filter((test) => test.category === category.code),
  ] as const),
);

/** Accepts "WSTG-INPV-05", "inpv-05", "INPV-5" or the WSTG section "4.7.5". */
export function normalizeWstgId(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";

  const sectionMatch = raw.match(/^\d+(?:\.\d+)+$/);
  if (sectionMatch) return WSTG_TEST_BY_SECTION.get(raw)?.id ?? raw;

  const withoutPrefix = raw.startsWith("WSTG-") ? raw.slice(5) : raw;
  const parts = withoutPrefix.match(/^([A-Z]{4})-(\d{1,2})$/);
  if (!parts) return raw;
  return `WSTG-${parts[1]}-${parts[2].padStart(2, "0")}`;
}

export function getWstgTest(value: unknown): WstgTest | undefined {
  const id = normalizeWstgId(value);
  return id ? WSTG_TEST_BY_ID.get(id) : undefined;
}

export function getWstgTestsByCategory(code: string): WstgTest[] {
  return WSTG_TESTS_BY_CATEGORY.get(String(code).toUpperCase()) ?? [];
}

export function getWstgCategory(code: string): WstgCategory | undefined {
  return WSTG_CATEGORIES.find((category) => category.code === String(code).toUpperCase());
}

export function isOwaspTop10Id(value: unknown): value is OwaspTop10Id {
  return typeof value === "string" && OWASP_ID_SET.has(value.trim().toUpperCase());
}

/** Accepts "A05:2025", "a05", "A5" or the category title "Injection". */
export function normalizeOwaspTop10Id(value: unknown): OwaspTop10Id | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toUpperCase();
  if (!raw) return undefined;

  const direct = OWASP_TOP10_2025.find(
    (category) => category.id.toUpperCase() === raw || category.title.toUpperCase() === raw,
  );
  if (direct) return direct.id;

  const rank = raw.match(/^A?(\d{1,2})(?::?(?:20)?25)?$/);
  if (rank) {
    const id = `A${rank[1].padStart(2, "0")}:2025`;
    return isOwaspTop10Id(id) ? id : undefined;
  }
  return undefined;
}

export function getOwaspCategory(value: unknown): OwaspTop10Category | undefined {
  const id = normalizeOwaspTop10Id(value);
  return id ? OWASP_TOP10_2025.find((category) => category.id === id) : undefined;
}

export function findWstgTestsForOwasp(value: unknown): WstgTest[] {
  const id = normalizeOwaspTop10Id(value);
  if (!id) return [];
  return WSTG_TESTS.filter((test) => test.owasp.includes(id));
}

export function allWstgTestIds(): string[] {
  return WSTG_TESTS.map((test) => test.id);
}

export function owaspLabel(value: unknown): string {
  const category = getOwaspCategory(value);
  return category ? `${category.id} ${category.title}` : "";
}