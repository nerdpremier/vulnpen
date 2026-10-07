/**
 * Pure projections behind the Nessus-style scan pages.
 *
 * A scan is persisted as a run record (see `run-queue.service.ts` for the
 * engine), but what the operator reads — the history a view shows, the
 * per-case result table, the findings a scan produced, the transcript slice
 * the activity log replays — is derived, never stored twice. Everything here
 * takes plain data in and returns plain data out, so the UI's poll and a
 * finished scan's replay read the same projection and both can be tested
 * without a database.
 */

import type {
  AgentMessageDoc,
  SessionTestCaseDoc,
  SessionVulnerabilityDoc,
  WebAppRunDoc,
  WebAppRunPolicy,
} from "../../models/Sessions/Sessions.model";
import type { WstgTestStatus } from "../../knowledge";

/**
 * A record's policy, with the pre-policy default. Records written before
 * scans carried one were launched to run by themselves, so they read as
 * unattended rather than as supervised.
 */
export function runPolicy(run: Pick<WebAppRunDoc, "policy">): WebAppRunPolicy {
  return run.policy === "supervised" ? "supervised" : "unattended";
}

/** The one rule for a scan label: trimmed, and capped to what the list shows. */
export function normalizeRunLabel(label: string | undefined): string {
  return (label ?? "").trim().slice(0, 120);
}

// ─── The run marker ───────────────────────────────────────────────────
// One owner for the string that cuts a scan's activity out of the shared
// transcript: the instruction builder writes it, the slice below reads it.

export function runMarker(runId: string): string {
  return `[WSTG run ${runId}]`;
}

/** True for any run's instruction line, i.e. the start of some other scan. */
export function isRunMarker(content: string | null | undefined): boolean {
  return (content ?? "").startsWith("[WSTG run ");
}

export interface RunListFilter {
  /** Only scans whose case set contains this WSTG id (the case page's view). */
  testId?: string;
}

/**
 * The scans a view asked for, newest first. The case page filters to the scans
 * that touched its case instead of rendering the session's whole history under
 * one case.
 */
export function selectRuns(
  runs: WebAppRunDoc[],
  filter: RunListFilter = {},
): WebAppRunDoc[] {
  const wanted = filter.testId?.trim().toUpperCase();
  const matching = wanted
    ? runs.filter((run) =>
        run.testIds.some((testId) => testId.toUpperCase() === wanted),
      )
    : runs;
  return [...matching].reverse();
}

/** What the UI needs about the queue to place a record in it. */
export interface QueuePosition {
  activeRunId: string | null;
  queue: string[];
}

export interface RunListItem extends WebAppRunDoc {
  position?: number;
  active: boolean;
}

/**
 * A record plus its queue position, counted the way the user counts it: behind
 * the scan already executing. `queued: position > 1` therefore means the same
 * thing here as it does in the launch response.
 */
export function decorateRun(run: WebAppRunDoc, state: QueuePosition): RunListItem {
  const ahead = state.activeRunId ? 1 : 0;
  return {
    ...run,
    active: run.runId === state.activeRunId,
    position:
      run.status === "queued"
        ? ahead + state.queue.indexOf(run.runId) + 1
        : undefined,
  };
}

/** One case of a scan, joined with the plan so the UI needs no second read. */
export interface RunCaseRow {
  testId: string;
  title: string;
  categoryCode?: string;
  status: WstgTestStatus;
  /** Findings the case links, in the order the plan lists them. */
  findingIds: string[];
  /** False when the case was removed from the plan after the scan ran. */
  inPlan: boolean;
}

/** One finding produced by the scan's cases. */
export interface RunFindingRow {
  vulnerabilityId: string;
  title: string;
  severity: string;
  testId?: string;
}

/**
 * The transcript slice of one run: everything its agent produced — reasoning,
 * tool cards and outputs — between its marker user message and the next run's
 * marker. The instruction and the model's internal notes never enter the feed.
 */
export function sliceRunActivity(
  messages: AgentMessageDoc[],
  runId: string,
): AgentMessageDoc[] {
  const marker = runMarker(runId);
  const startIndex = messages.findIndex(
    (message) => message.role === "user" && message.content?.startsWith(marker),
  );
  if (startIndex < 0) return [];

  let endIndex = messages.length;
  for (let i = startIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "user" && isRunMarker(message.content)) {
      endIndex = i;
      break;
    }
  }

  return messages
    .slice(startIndex + 1, endIndex)
    .filter((message) => message.role === "assistant" || message.role === "tool");
}

/**
 * A run's outcome from the plan: each requested case's current status plus
 * Nessus-style counts.
 */
export function buildResultSummary(
  testIds: string[],
  planCases: { testId: string; status: string }[] | null,
): WebAppRunDoc["resultSummary"] {
  const perCase = testIds.map((testId) => ({
    testId,
    status:
      (planCases?.find((testCase) => testCase.testId === testId)?.status as never) ??
      "not_started",
  }));
  const counts = { passed: 0, failed: 0, blocked: 0, other: 0 };
  for (const entry of perCase) {
    if (entry.status === "passed") counts.passed += 1;
    else if (entry.status === "failed") counts.failed += 1;
    else if (entry.status === "blocked") counts.blocked += 1;
    else counts.other += 1;
  }
  return { perCase, counts };
}

/**
 * Join a scan's case ids with the plan: what the case is called, where it
 * stands now, and which findings it carries. A case removed from the plan
 * after the scan still shows (inPlan: false) rather than disappearing from the
 * scan's own history.
 */
export function runCaseRows(
  testIds: string[],
  planCases: SessionTestCaseDoc[] | null,
): RunCaseRow[] {
  return testIds.map((testId) => {
    const testCase = planCases?.find((entry) => entry.testId === testId);
    return {
      testId,
      title: testCase?.title ?? testId,
      categoryCode: testCase?.categoryCode,
      status: (testCase?.status ?? "not_started") as WstgTestStatus,
      findingIds: (testCase?.linkedVulnerabilityIds ?? []).map(String),
      inPlan: testCase != null,
    };
  });
}

/** The findings the scan's cases link to, in case order, without duplicates. */
export function runFindings(
  cases: RunCaseRow[],
  vulnerabilities: SessionVulnerabilityDoc[] | null,
): RunFindingRow[] {
  const seen = new Set<string>();
  const rows: RunFindingRow[] = [];
  for (const testCase of cases) {
    for (const findingId of testCase.findingIds) {
      if (seen.has(findingId)) continue;
      seen.add(findingId);
      const finding = vulnerabilities?.find(
        (entry) => String(entry.vulnerabilityId) === findingId,
      );
      rows.push({
        vulnerabilityId: findingId,
        title: finding?.title ?? findingId,
        severity: finding?.severity ?? "info",
        testId: testCase.testId,
      });
    }
  }
  return rows;
}
