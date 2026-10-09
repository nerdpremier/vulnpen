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
  /**
   * The tools on *this* box that make the test efficient — a curated,
   * project-specific list, NOT an OWASP publication.
   *
   * WSTG v4.2 does carry a `## Tools` section, but only in 55 of the 97 cases,
   * and it is prose ("Figure 4.1.8-8: Whatweb Output sample", "Regular
   * expressions"), so it cannot be transcribed as a tool list. This field names
   * what the agent should actually reach for here: a registered agent tool
   * (`run_bash`, `send_to_burp_repeater`, `browser_action`, …) or a capability
   * in `src/capabilities/registry.ts`.
   *
   * That invariant is enforced by `tests/catalogConformance.test.ts`: a name
   * that is neither a registered tool nor a known capability fails the suite,
   * so this field can never point at a tool the box does not have.
   */
  tools: string[];
  /** Evidence that must be captured for a report-ready result. */
  evidence: string;
}