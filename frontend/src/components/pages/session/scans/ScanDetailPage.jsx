"use client";

import React, { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "react-query";
import { App, Button, Tooltip } from "antd";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  RedoOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { getTestPlan } from "@/services/websecurity.service";
import { connectAgentStream } from "@/services/agent.service";
import useScanActivity from "@/hooks/useScanActivity";
import useScanMutations, { invalidateScanCaches } from "@/hooks/useScanMutations";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { DonutChart, PageShell, PageState } from "@/components/common/ui";
import {
  compareBySeverity,
  findingsBySeverity,
  SEVERITY_LEVELS,
} from "@/utils/findings.mjs";
import { testPlanKey } from "@/utils/scanQueryKeys.mjs";
import {
  formatDuration,
  formatStamp,
  isScanLive,
  scanFindingsByCase,
  scanName,
  scanPolicy,
  scanProgress,
  scanRemediations,
} from "@/utils/scans.mjs";
import AgentLogStream from "./AgentLogStream";
import { ScanStatusPill, ScanProgressBar } from "./ScanStatus";
import ConsentBanner from "../sessionId/ConsentBanner";
import styles from "@/styles/pages/TestPlan.module.scss";
import vStyles from "@/styles/pages/Vulnerabilities.module.scss";
import detail from "@/styles/pages/ScanDetail.module.scss";

/**
 * One scan, read the way Tenable reads a report: the scan's name over a row
 * of counted tabs (Cases / Findings / Remediations / Agent log), the tab's
 * table on the left, and one sidebar that stays with every tab — the Scan
 * Details card and the severity donut. Approving a parked supervised scan
 * happens here too, on the scan itself rather than in the middle of a chat.
 */

/* The results table's read-only chip keeps its own `--pill` contract. */
const CASE_PILL_TONE = {
  not_started: styles.pillIdle,
  in_progress: styles.pillActive,
  passed: styles.pillPassed,
  failed: styles.pillFailed,
  blocked: styles.pillBlocked,
  skipped: styles.pillIdle,
};

/**
 * The per-case findings cell, Nessus's stacked host bar: one segment per
 * severity that the case actually produced, widest where it hurts most, the
 * count printed inside. A case with no finding says so in one dim word.
 */
function CaseFindingsStrip({ strip }) {
  if (!strip || !strip.total) {
    return <span className={detail.caseNoFindings}>none</span>;
  }
  const segments = SEVERITY_LEVELS.map(({ key }) => ({
    severity: key,
    count: strip.counts[key] ?? 0,
  })).filter((segment) => segment.count > 0);

  return (
    <span
      className={detail.caseFindings}
      role="img"
      aria-label={segments.map((s) => `${s.count} ${s.severity}`).join(", ")}
    >
      {segments.map((segment) => (
        <span
          key={segment.severity}
          className={detail.caseFindingsSeg}
          data-severity={segment.severity}
          style={{ flexGrow: segment.count }}
          title={`${segment.count} ${segment.severity}`}
        >
          {segment.count}
        </span>
      ))}
    </span>
  );
}

export default function ScanDetailPage({ sessionId, runId }) {
  const router = useRouter();
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("cases");

  const activity = useScanActivity(sessionId, runId);
  const run = activity.run;
  // The plan is the live source of per-case status: poll it while the scan
  // runs, or the progress bar and the case table never move.
  const { data: planData } = useQuery(
    testPlanKey(sessionId),
    () => getTestPlan(sessionId),
    { refetchInterval: activity.live ? 4000 : false },
  );
  const planCases = useMemo(() => planData?.plan?.cases ?? [], [planData]);

  // The list is cached by the scans page too; the one invalidation policy keeps
  // the views agreeing after a stop, a delete or a re-run.
  const invalidate = useCallback(() => {
    invalidateScanCaches(queryClient, sessionId);
  }, [queryClient, sessionId]);

  const { stop: stopMutation, remove: deleteMutation, launch: rerunMutation } =
    useScanMutations(sessionId);

  // Approval rides the same consent endpoint the chat uses; the continuation is
  // persisted server-side, so this page only has to refresh its poll.
  const handleConsent = useCallback(
    (approved, toolCallIds) => {
      connectAgentStream({
        sessionId,
        message: JSON.stringify({
          approved,
          ...(Array.isArray(toolCallIds) ? { toolCallIds } : {}),
        }),
        endpoint: "consent",
      }).then((stream) => {
        stream.onEvent("error", (payload) => {
          message.error(
            payload?.message ||
              "The approval could not be delivered — the scan is still waiting.",
          );
        });
        stream.onEvent("_stream_end", () => {
          // Let the next poll tick show the new state.
          setTimeout(invalidate, 300);
        });
      });
    },
    [sessionId, invalidate, message],
  );

  const live = isScanLive(run);
  const queued = run?.status === "queued";

  /** Live progress of this scan (its own cases only), or null once settled. */
  const progress = useMemo(
    () =>
      live
        ? scanProgress(run.testIds, planCases, { since: run.startedAt })
        : null,
    [live, run, planCases],
  );

  const findings = useMemo(
    () => findingsBySeverity(activity.findings),
    [activity.findings],
  );

  /** Per-case severity buckets for the Cases tab's stacked findings cell. */
  const findingsByCase = useMemo(
    () => scanFindingsByCase(activity.findings),
    [activity.findings],
  );

  /** The Remediations tab: the distinct fixes, worst news first. */
  const remediations = useMemo(
    () => scanRemediations(activity.findings),
    [activity.findings],
  );

  /** The donut's composition — Nessus's Vulnerabilities panel. */
  const donutSegments = useMemo(
    () =>
      findings.levels
        .map((level) => ({
          key: level.key,
          label: level.label,
          value: level.count,
          tone: level.key,
        }))
        .filter((segment) => segment.value > 0),
    [findings],
  );

  /** Which WSTG category each finding's case belongs to, for the Findings tab. */
  const categoryByCase = useMemo(() => {
    const map = new Map();
    for (const testCase of activity.cases) {
      map.set(testCase.testId, testCase.categoryCode || "OTHER");
    }
    return map;
  }, [activity.cases]);

  // The severity ordering is findings.mjs's contract; the title only breaks
  // ties so a same-severity pair reads alphabetically.
  const rankedFindings = useMemo(
    () =>
      [...activity.findings].sort(
        (a, b) =>
          compareBySeverity(a, b) ||
          String(a.title).localeCompare(String(b.title)),
      ),
    [activity.findings],
  );

  const startedAt = run?.startedAt ?? null;
  const endedAt = run?.finishedAt ?? null;
  const elapsed =
    run?.durationMs != null ? formatDuration(run.durationMs) : live ? "running" : "—";

  const backToScans = () => router.push(`/session/${sessionId}/scans`);

  if (activity.isLoading) {
    return (
      <PageShell>
        <header className={detail.backRow}>
          <button className={vStyles.backButton} onClick={backToScans}>
            <ArrowLeftOutlined /> Back to My Scans
          </button>
        </header>
        <PageState state="loading" rows={4} />
      </PageShell>
    );
  }

  if (activity.isError) {
    return (
      <PageShell>
        <header className={detail.backRow}>
          <button className={vStyles.backButton} onClick={backToScans}>
            <ArrowLeftOutlined /> Back to My Scans
          </button>
        </header>
        <PageState
          state="error"
          title="Could not load this scan"
          description="Its cases, findings and log are unavailable."
          onRetry={invalidate}
        />
      </PageShell>
    );
  }

  if (!run) {
    return (
      <PageShell>
        <header className={detail.backRow}>
          <button className={vStyles.backButton} onClick={backToScans}>
            <ArrowLeftOutlined /> Back to My Scans
          </button>
        </header>
        <PageState
          state="empty"
          title="This scan is no longer in the history"
          description="It was deleted, or it never belonged to this engagement."
          actions={<Button onClick={backToScans}>Back to My Scans</Button>}
        />
      </PageShell>
    );
  }

  /* Stopping aborts the run for good, so it asks first and says what is lost. */
  const confirmStop = () => {
    const remaining = progress ? progress.total - progress.done : 0;
    confirmPopUp({
      title: `Stop “${scanName(run, planCases)}”?`,
      content: remaining
        ? `${remaining} of its ${run.testIds.length} case${run.testIds.length === 1 ? "" : "s"} have no result yet. A stopped scan cannot be resumed.`
        : "The run ends immediately and cannot be resumed.",
      okText: "Stop scan",
      onOk: () => stopMutation.mutateAsync(runId),
    });
  };

  const TABS = [
    { key: "cases", label: "Cases", count: run.testIds.length },
    { key: "findings", label: "Findings", count: activity.findings.length },
    { key: "remediations", label: "Remediations", count: remediations.length },
  ];

  return (
    <PageShell>
      <header className={detail.reportHead}>
        <div className={detail.reportTopRow}>
          <button className={vStyles.backButton} onClick={backToScans}>
            <ArrowLeftOutlined /> Back to My Scans
          </button>
          <div className={detail.reportActions}>
            {live ? (
              <Button
                danger
                icon={<StopOutlined />}
                loading={stopMutation.isLoading}
                onClick={confirmStop}
              >
                Stop scan
              </Button>
            ) : (
              <>
                <Button
                  icon={<RedoOutlined />}
                  loading={rerunMutation.isLoading}
                  onClick={() =>
                    rerunMutation.mutate({
                      testIds: run.testIds,
                      label: `${scanName(run, planCases)} (retest)`,
                      policy: scanPolicy(run),
                      onLaunched: (newRun) => {
                        if (newRun?.runId)
                          router.push(`/session/${sessionId}/scans/${newRun.runId}`);
                      },
                    })
                  }
                >
                  Launch again
                </Button>
                <Tooltip title="Delete this scan from the history">
                  <Button
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      confirmPopUp({
                        title: `Delete “${scanName(run, planCases)}”?`,
                        content:
                          "The scan disappears from the history. Results stay on the plan and findings stay on the Vulnerabilities page.",
                        okText: "Delete",
                        onOk: () =>
                          deleteMutation
                            .mutateAsync(runId)
                            .then(() => backToScans())
                            .catch(() => {}),
                      })
                    }
                  />
                </Tooltip>
              </>
            )}
          </div>
        </div>

        <div className={detail.reportTitleRow}>
          <h1 className={detail.reportTitle}>{scanName(run, planCases)}</h1>
          <ScanStatusPill status={run.status} />
          <span className={detail.reportTag}>{scanPolicy(run)}</span>
          {queued && (
            <span className={detail.reportTag}>
              {run.position > 1 ? `#${run.position} in queue` : "next to start"}
            </span>
          )}
        </div>

        {run.status === "failed" && run.error && (
          <p className={styles.scanError}>{run.error}</p>
        )}

        {activity.pendingConsent && (
          <div className={styles.scanConsent}>
            <p className={styles.scanConsentLead}>
              This scan is waiting for your approval before it continues.
            </p>
            <ConsentBanner
              pendingConsent={activity.pendingConsent}
              onApprove={(ids) => handleConsent(true, ids)}
              onDeny={() => handleConsent(false)}
            />
          </div>
        )}

        {/* Nessus's counted tabs: the number is on the tab, not in the table. */}
        <div className={detail.reportTabs}>
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`${detail.reportTab} ${tab === entry.key ? detail.reportTabActive : ""}`}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
              {entry.count > 0 && (
                <span className={detail.reportTabCount}>{entry.count}</span>
              )}
            </button>
          ))}
          <button
            type="button"
            className={`${detail.reportTab} ${tab === "log" ? detail.reportTabActive : ""}`}
            onClick={() => setTab("log")}
          >
            Agent log
            {live && <span className={detail.reportTabLive} aria-label="live" />}
          </button>
        </div>
      </header>

      <div className={detail.reportLayout}>
        <main className={detail.reportMain}>
          {tab === "cases" && (
            <div className={styles.scanTable}>
              <div className={styles.scanTableHead}>
                <span>Case</span>
                <span>Status</span>
                <span>Findings</span>
              </div>
              {activity.cases.map((testCase) => (
                <div key={testCase.testId} className={styles.scanTableRow}>
                  <span className={styles.scanIdentity}>
                    <Link
                      href={`/session/${sessionId}/test-plan/${testCase.testId}`}
                      className={styles.scanCaseLink}
                    >
                      {testCase.testId}
                    </Link>
                    <span className={styles.scanMeta}>
                      {testCase.title}
                      {testCase.inPlan ? "" : " · no longer in the plan"}
                    </span>
                  </span>
                  <span
                    className={`${styles.scanCasePill} ${CASE_PILL_TONE[testCase.status] ?? ""}`}
                  >
                    {testCase.status.replace("_", " ")}
                  </span>
                  <CaseFindingsStrip strip={findingsByCase.get(testCase.testId)} />
                </div>
              ))}
              {!activity.cases.length && (
                <p className={styles.activityEmpty}>This scan has no recorded cases.</p>
              )}
            </div>
          )}

          {tab === "findings" && (
            <div className={styles.scanTable}>
              {activity.findings.length ? (
                <>
                  <div className={`${detail.reportTableHead} ${detail.findingsCols}`}>
                    <span>Sev</span>
                    <span>CVSS</span>
                    <span>Finding</span>
                    <span>Category</span>
                  </div>
                  {rankedFindings.map((finding) => {
                    const severity = String(finding.severity ?? "").toLowerCase();
                    return (
                      <div
                        key={finding.vulnerabilityId}
                        className={`${detail.reportTableRow} ${detail.findingsCols}`}
                      >
                        <span
                          className={`${vStyles.severity} ${vStyles[severity] ?? ""}`}
                        >
                          {severity}
                        </span>
                        <span className={detail.findingCvss}>
                          {finding.cvssScore != null ? finding.cvssScore : "…"}
                        </span>
                        <span className={styles.scanIdentity}>
                          <Link
                            href={`/session/${sessionId}/vulnerabilities/${finding.vulnerabilityId}`}
                            className={styles.findingLink}
                          >
                            {finding.title}
                          </Link>
                          <span className={styles.scanMeta}>
                            {finding.testId || "—"}
                          </span>
                        </span>
                        <span className={detail.findingCategory}>
                          {categoryByCase.get(finding.testId) ?? "—"}
                        </span>
                      </div>
                    );
                  })}
                </>
              ) : (
                <p className={styles.activityEmpty}>
                  {live
                    ? "The agent has not recorded a finding for this scan yet."
                    : "This scan recorded no findings."}
                </p>
              )}
            </div>
          )}

          {tab === "remediations" && (
            <div className={styles.scanTable}>
              {remediations.length ? (
                <>
                  <div className={`${detail.reportTableHead} ${detail.remediationCols}`}>
                    <span>Action</span>
                    <span>Findings</span>
                    <span>Cases</span>
                  </div>
                  {remediations.map((entry) => (
                    <div
                      key={entry.action}
                      className={`${detail.reportTableRow} ${detail.remediationCols}`}
                    >
                      <span className={`${styles.scanIdentity} ${detail.remediationRow}`}>
                        <span
                          className={`${vStyles.severity} ${vStyles[entry.worst] ?? ""}`}
                          title={`worst severity: ${entry.worst}`}
                        >
                          {entry.worst}
                        </span>
                        <span className={detail.remediationText}>{entry.action}</span>
                      </span>
                      <span className={detail.remediationCount}>{entry.vulns}</span>
                      <span className={detail.remediationCount}>{entry.cases}</span>
                    </div>
                  ))}
                </>
              ) : (
                <p className={styles.activityEmpty}>
                  {live
                    ? "Nothing to remediate yet — the scan is still working."
                    : "Nothing to remediate: this scan recorded no findings."}
                </p>
              )}
            </div>
          )}

          {tab === "log" && (
            <div className={styles.runActivityWrap}>
              <div className={`${styles.runLiveBadge} ${live ? styles.runToneRunning : ""}`}>
                {live ? "● live" : "replay"}
              </div>
              <AgentLogStream
                sessionId={sessionId}
                visibleMessages={activity.visibleMessages}
                toolIndex={activity.toolIndex}
                finished={!live}
              />
            </div>
          )}
        </main>

        {/* The sidebar that stays with every tab, like Nessus's Scan Details. */}
        <aside className={detail.reportAside}>
          <section className={detail.reportCard}>
            <h2 className={detail.reportCardTitle}>Scan Details</h2>
            <dl className={detail.reportFacts}>
              <div className={detail.reportFact}>
                <dt>Policy</dt>
                <dd>{scanPolicy(run) === "supervised" ? "Supervised" : "Unattended"}</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>Status</dt>
                <dd>{run.status}</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>Severity base</dt>
                <dd>CVSS v3.0</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>Scanner</dt>
                <dd>AI agent</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>Cases</dt>
                <dd>{run.testIds.length}</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>Start</dt>
                <dd>{formatStamp(startedAt)}</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>End</dt>
                <dd>{formatStamp(endedAt)}</dd>
              </div>
              <div className={detail.reportFact}>
                <dt>Elapsed</dt>
                <dd>{elapsed}</dd>
              </div>
            </dl>
            {live && (
              <div className={detail.reportProgress}>
                <ScanProgressBar
                  testIds={run.testIds}
                  planCases={planCases}
                  since={run.startedAt}
                />
              </div>
            )}
          </section>

          <section className={detail.reportCard}>
            <h2 className={detail.reportCardTitle}>Vulnerabilities</h2>
            {activity.findings.length ? (
              <div className={detail.reportDonut}>
                <DonutChart
                  segments={donutSegments}
                  size={124}
                  thickness={13}
                  centerValue={activity.findings.length}
                  centerLabel="findings"
                  legend="column"
                />
              </div>
            ) : (
              <p className={detail.reportCardEmpty}>
                {live ? "None recorded yet." : "This scan recorded none."}
              </p>
            )}
          </section>
        </aside>
      </div>
    </PageShell>
  );
}
