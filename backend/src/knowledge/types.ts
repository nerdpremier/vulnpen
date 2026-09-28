/**
 * Shared types for the static OWASP knowledge base that powers the
 * Web Application Security Testing assistant.
 *
 * The catalogs beside this file are plain reference data: OWASP WSTG v4.2 test
 * cases (https://github.com/OWASP/wstg) and the OWASP Top 10:2025
 * (https://owasp.org/Top10/2025/). Services build test plans, map findings to
 * the Top 10 and draft reports from them, so the shapes below are the contract
 * those services depend on.
 */

export type OwaspTop10Id =
  | "A01:2025"
  | "A02:2025"
  | "A03:2025"
  | "A04:2025"
  | "A05:2025"
  | "A06:2025"
  | "A07:2025"
  | "A08:2025"
  | "A09:2025"
  | "A10:2025";

export type WstgCategoryCode =
  | "INFO"
  | "CONF"
  | "IDNT"
  | "ATHN"
  | "ATHZ"
  | "SESS"
  | "INPV"
  | "ERRH"
  | "CRYP"
  | "BUSL"
  | "CLNT"
  | "APIT";

/** Lifecycle of a single test case inside a session test plan. */
export type WstgTestStatus =
  | "not_started"
  | "in_progress"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped";

/** How much of the WSTG v4.2 catalogue a generated plan covers. */
export type TestPlanDepth = "smoke" | "standard" | "deep" | "full";

export interface OwaspTop10Category {
  /** Official identifier, e.g. "A05:2025". */
  id: OwaspTop10Id;
  /** Position in the published 2025 list (1-10). */
  rank: number;
  /** Official title, e.g. "Injection". */
  title: string;
  /** One or two sentences describing the risk category. */
  summary: string;
  /** CWE identifiers the OWASP Top 10:2025 lists for this category. */
  cwes: string[];
  /** WSTG v4.2 test ids that exercise this category. */
  wstgFocus: string[];
  /** Concrete signals to look for while testing. */
  detection: string[];
  /** Remediation guidance for findings in this category. */
  remediation: string[];
}

export interface WstgCategory {
  code: WstgCategoryCode;
  /** Section number in the WSTG, e.g. "4.7". */
  section: string;
  name: string;
  objective: string;
}

export interface WstgTest {
  /** Canonical test id, e.g. "WSTG-INPV-05". */
  id: string;
  /** Section number in the WSTG, e.g. "4.7.5". */
  section: string;
  category: WstgCategoryCode;
  title: string;
  /** What the test proves, in one sentence. */
  objective: string;
  /** How to run the test, including the sub-techniques WSTG lists under it. */
  howToTest: string;
  /** OWASP Top 10:2025 mapping, most relevant category first. */
  owasp: OwaspTop10Id[];
  /** Primary CWEs for findings produced by this test. */
  cwe: string[];
  /** Tools on the attack box that make this test efficient. */
  tools: string[];
  /** Evidence that must be captured for a report-ready result. */
  evidence: string;
}