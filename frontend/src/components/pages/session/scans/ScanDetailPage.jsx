"use client";

import React, { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { App, Button, Tooltip } from "antd";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  RedoOutlined,
  StopOutlined,
} from "@ant-design/icons";
import {
  FiAlertTriangle,
  FiCheckCircle,
  FiClock,
  FiList,
  FiMinusCircle,
  FiSlash,
  FiTarget,
  FiXCircle,
} from "react-icons/fi";
import {
  deleteScan,
  getTestPlan,
  launchScan,
  stopScan,
} from "@/services/websecurity.service";
import { connectAgentStream } from "@/services/agent.service";
import { useAgentStreamStore } from "@/store/agentStream.store";
import useScanActivity from "@/hooks/useScanActivity";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import {
  BarList,
  DonutChart,
  GaugeArc,
  PageShell,
  PageState,
  SeverityBar,
  StatStrip,
  StatTile,
} from "@/components/common/ui";
import { apiErrorMessage } from "@/utils/apiError";
import { findingsBySeverity } from "@/utils/findings.mjs";
import {
  countScanCases,
  formatDuration,
  isScanLive,
  scanCaseStatuses,
  scanName,
  scanProgress,
  scanScopeLabel,
} from "@/utils/scans.mjs";
import AgentLogStream from "./AgentLogStream";
import { ScanStatusPill } from "./ScanStatus";
import ConsentBanner from "../sessionId/ConsentBanner";
import styles from "@/styles/pages/TestPlan.module.scss";
import vStyles from "@/styles/pages/Vulnerabilities.module.scss";
import detail from "@/styles/pages/ScanDetail.module.scss";

/**
 * One scan, read as a shape before it is read as a sentence: a readout band,
 * the completion dial, what the run settled, where it went looking — and then
 * the per-case detail, the findings and, behind the last tab, the agent log
 * that explains the result. Approving a parked supervised scan happens here
 * too, on the scan itself rather than in the middle of a chat feed.
 */

const CASE_TONE = {
  passed: detail.segPassed,
  failed: detail.segFailed,
  blocked: detail.segBlocked,
  in_progress: detail.segActive,
  skipped: detail.segSkipped,
  not_started: detail.segIdle,
};

/* The results table's read-only chip keeps its own `--pill` contract. */
const CASE_PILL_TONE = {
  not_started: styles.pillIdle,
  in_progress: styles.pillActive,
  passed: styles.pillPassed,
  failed: styles.pillFailed,
  blocked: styles.pillBlocked,
  skipped: styles.pillIdle,
};

const TABS = [
  { key: "results", label: "Results" },
  { key: "findings", label: "Findings" },
  { key: "log", label: "Agent log" },
];

/* Legend order: the three outcomes a settlement produces, then the states. */
const STRIP_ORDER = [
  { key: "passed", label: "passed" },
  { key: "failed", label: "failed" },
  { key: "blocked", label: "blocked" },
  { key: "skipped", label: "skipped" },
  { key: "in_progress", label: "in progress" },
  { key: "not_started", label: "not started" },
];

/**
 * The whole run in one strip: a segment per case, in the order the run lists
 * them, coloured by how the case ended. A live scan's strip fills in as its
 * cases settle, so the row moves instead of a count ticking somewhere else.
 */
function RunStrip({ cases }) {
  const tally = new Map();
  for (const entry of cases) {
    tally.set(entry.status, (tally.get(entry.status) ?? 0) + 1);
  }
  const legend = STRIP_ORDER.map((entry) => ({
    ...entry,
    count: tally.get(entry.key) ?? 0,
  })).filter((entry) => entry.count > 0);

  return (
    <div className={detail.strip}>
      <span
        className={detail.stripTrack}
        role="img"
        aria-label={`${cases.length} cases: ${legend
          .map((entry) => `${entry.count} ${entry.label}`)
          .join(", ")}`}
      >
        {cases.map((entry) => (
          <span
            key={entry.testId}
            className={`${detail.stripSeg} ${CASE_TONE[entry.status] ?? detail.segIdle}`}
            style={{ flexGrow: 1 }}
            title={`${entry.testId} — ${entry.status.replace("_", " ")}`}
          />
        ))}
      </span>

      <ul className={detail.stripLegend}>
        {legend.map((entry) => (
          <li key={entry.key} className={detail.stripLegendItem}>
            <span
              className={`${detail.stripSwatch} ${CASE_TONE[entry.key] ?? detail.segIdle}`}
              aria-hidden="true"
            />
            <b>{entry.count}</b>
            <span>{entry.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ScanDetailPage({ sessionId, runId }) {
  const router = useRouter();
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("results");

  const activity = useScanActivity(sessionId, runId);
  const run = activity.run;
  // The plan is the live source of per-case status: poll it while the scan
  // runs, or the progress bar and the "settled" tile never move.
  const { data: planData } = useQuery(["test-plan", sessionId], () => getTestPlan(sessionId), {
    refetchInterval: activity.live ? 4000 : false,
  });
  const planCases = useMemo(() => planData?.plan?.cases ?? [], [planData]);

  // The list is cached by the scans page too; invalidating it keeps the two
  // views agreeing after a stop, a delete or a re-run.
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries(["scan", sessionId, runId]);
    queryClient.invalidateQueries(["scans", sessionId]);
    queryClient.invalidateQueries(["test-plan", sessionId]);
  }, [queryClient, sessionId, runId]);

  const stopMutation = useMutation(() => stopScan(sessionId, runId), {
    onSuccess: () => {
      message.success("Stopping the scan");
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not stop the scan")),
  });

  const deleteMutation = useMutation(() => deleteScan(sessionId, runId), {
    onSuccess: () => {
      message.success("Scan deleted");
      // Drop the detail cache as well: its poll has stopped, so Browser-Back
      // would otherwise re-render the record that no longer exists.
      queryClient.removeQueries(["scan", sessionId, runId]);
      queryClient.invalidateQueries(["scans", sessionId]);
      router.push(`/session/${sessionId}/scans`);
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not delete the scan")),
  });

  const rerunMutation = useMutation(launchScan, {
    onSuccess: (data) => {
      message.success("Re-run queued");
      queryClient.invalidateQueries(["scans", sessionId]);
      useAgentStreamStore.getState().markHistoryStale?.(sessionId);
      if (data?.run?.runId) router.push(`/session/${sessionId}/scans/${data.run.runId}`);
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not re-run the scan")),
  });

  // Approval rides the same consent endpoint the chat uses; the continuation is
  // persisted server-side, so this page only has to refresh its poll.
  const handleConsent = useCallback(
    (approved, toolCallIds) => {
      // `connectAgentStream` resolves with a controller as soon as the request
      // is away and reports failures as `error` events, so the old
      // `.catch(() => {})` could never fire: a rejected approval looked exactly
      // like an accepted one.
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

  // What this scan settled, from its own snapshot once it has one.
  const counts = useMemo(
    () => countScanCases(scanCaseStatuses(run, planCases)),
    [run, planCases],
  );

  /**
   * While the scan is live, "settled" means settled *by this scan*. The plan
   * still carries the previous scan's results, so without the `since` guard a
   * re-run of an already-covered case reads 100% complete before it starts —
   * the tile said "10/10 settled" while the bar sat at 0%.
   */
  const progress = useMemo(
    () =>
      live
        ? scanProgress(run.testIds, planCases, { since: run.startedAt })
        : null,
    [live, run, planCases],
  );
  const settled = progress ? progress.done : counts.total - counts.notExecuted;
  const settledTotal = progress ? progress.total : counts.total;

  /**
   * The composition the readout and the dial both draw. A live scan reports
   * what *it* has settled so far (the plan's statuses may belong to an earlier
   * scan); a settled scan reports its own snapshot.
   */
  const composition = useMemo(() => {
    if (progress) {
      return {
        passed: progress.counts.passed,
        failed: progress.counts.failed,
        blocked: progress.counts.blocked,
        skipped: 0,
        notExecuted: Math.max(progress.total - progress.done, 0),
      };
    }
    return {
      passed: counts.passed,
      failed: counts.failed,
      blocked: counts.blocked,
      skipped: counts.skipped,
      notExecuted: counts.notExecuted,
    };
  }, [progress, counts]);

  const completion = settledTotal > 0 ? Math.round((settled / settledTotal) * 100) : 0;
  const outcomeTone =
    run?.status === "failed" || composition.failed > 0
      ? "danger"
      : composition.blocked > 0
        ? "warning"
        : live
          ? "info"
          : "success";

  const findings = useMemo(
    () => findingsBySeverity(activity.findings),
    [activity.findings],
  );

  /* Categories this run went looking in, ranked by how much of it they took. */
  const categories = useMemo(() => {
    const map = new Map();
    for (const testCase of activity.cases) {
      const key = testCase.categoryCode || "OTHER";
      const entry = map.get(key) ?? { key, cases: 0, findings: 0 };
      entry.cases += 1;
      entry.findings += testCase.findingIds?.length ?? 0;
      map.set(key, entry);
    }
    return [...map.values()].sort(
      (a, b) => b.cases - a.cases || a.key.localeCompare(b.key),
    );
  }, [activity.cases]);

  const startedAt = run?.startedAt ?? run?.queuedAt ?? null;
  const elapsed =
    run?.durationMs != null ? formatDuration(run.durationMs) : live ? "running" : "—";

  const backToScans = () => router.push(`/session/${sessionId}/scans`);

  if (activity.isLoading) {
    return (
      <PageShell>
        <header className={detail.backRow}>
          <button className={vStyles.backButton} onClick={backToScans}>
            <ArrowLeftOutlined /> All scans
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
            <ArrowLeftOutlined /> All scans
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
            <ArrowLeftOutlined /> All scans
          </button>
        </header>
        <PageState
          state="empty"
          title="This scan is no longer in the history"
          description="It was deleted, or it never belonged to this engagement."
          actions={<Button onClick={backToScans}>All scans</Button>}
        />
      </PageShell>
    );
  }

  /* Stopping aborts the run for good, so it asks first and says what is lost. */
  const confirmStop = () => {
    const remaining = counts.total - settled;
    confirmPopUp({
      title: `Stop “${scanName(run, planCases)}”?`,
      content: remaining
        ? `${remaining} of its ${counts.total} case${counts.total === 1 ? "" : "s"} have no result yet. A stopped scan cannot be resumed.`
        : "The run ends immediately and cannot be resumed.",
      okText: "Stop scan",
      onOk: () => stopMutation.mutateAsync(),
    });
  };

  return (
    <PageShell>
      <header className={styles.scanDetailHead}>
        <div className={styles.scansHeroTop}>
          <button className={vStyles.backButton} onClick={backToScans}>
            <ArrowLeftOutlined /> All scans
          </button>
          <div className={styles.scansHeroActions}>
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
                      sessionId,
                      testIds: run.testIds,
                      label: `${scanName(run, planCases)} (retest)`,
                      policy: run.policy ?? "unattended",
                    })
                  }
                >
                  Run again
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
                        onOk: () => deleteMutation.mutateAsync(),
                      })
                    }
                  />
                </Tooltip>
              </>
            )}
          </div>
        </div>

        <div className={styles.scanDetailTitleRow}>
          <h1 className={styles.scansTitle}>{scanName(run, planCases)}</h1>
          <ScanStatusPill status={run.status} />
          <span className={styles.policyTag}>
            {run.policy === "supervised" ? "supervised" : "unattended"}
          </span>
          {run.status === "queued" && (
            <span className={styles.policyTag}>
              {run.position > 1 ? `#${run.position} in queue` : "next to start"}
            </span>
          )}
        </div>

        <p
          className={styles.scansLead}
          title={planData?.plan?.scope ? `Scope: ${planData.plan.scope}` : undefined}
        >
          {scanScopeLabel(run, planCases)} against{" "}
          {planData?.plan?.target || "the engagement target"}
        </p>

        {/* The readout: every number a tester asks for, one band, no sentence. */}
        <StatStrip className={detail.kpis}>
          <StatTile
            label="Cases"
            icon={<FiList />}
            value={run.testIds.length}
            hint="in this run"
          />
          <StatTile
            label="Settled"
            icon={<FiTarget />}
            value={settled}
            total={settledTotal}
            hint={live ? "by this run so far" : "with a result"}
          />
          <StatTile
            label="Passed"
            icon={<FiCheckCircle />}
            value={composition.passed}
            tone={composition.passed ? "success" : "neutral"}
            hint="clean"
          />
          <StatTile
            label="Failed"
            icon={<FiXCircle />}
            value={composition.failed}
            tone={composition.failed ? "danger" : "neutral"}
            hint={composition.failed ? "needs a retest" : "none"}
          />
          <StatTile
            label="Blocked"
            icon={<FiSlash />}
            value={composition.blocked}
            tone={composition.blocked ? "warning" : "neutral"}
            hint={composition.blocked ? "could not run" : "none"}
          />
          <StatTile
            label="Not executed"
            icon={<FiMinusCircle />}
            value={composition.notExecuted}
            tone={composition.notExecuted ? "warning" : "success"}
            hint={composition.notExecuted ? "no result yet" : "all settled"}
          />
          <StatTile
            label="Findings"
            icon={<FiAlertTriangle />}
            value={activity.findings.length}
            tone={activity.findings.length ? "danger" : "neutral"}
            hint={activity.findings.length ? "recorded by this run" : "nothing recorded"}
          />
          <StatTile
            label="Elapsed"
            icon={<FiClock />}
            value={elapsed}
            count={false}
            hint={
              startedAt
                ? `from ${new Date(startedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`
                : "not started"
            }
          />
        </StatStrip>

        {/* Two shapes, two questions: did it finish, and how did it go. */}
        <div className={detail.panels}>
          <section className={detail.panel}>
            <header className={detail.panelHead}>
              <h2 className={detail.panelTitle}>Outcome</h2>
              <span className={detail.panelNote}>
                {/* Only the percentage: the dial draws the count and the
                    settled/total pair, and the readout band above prints the
                    same pair again. */}
                {completion}% settled
              </span>
            </header>
            <div className={detail.outcomeRow}>
              <GaugeArc
                value={settled}
                max={settledTotal || 1}
                size={150}
                thickness={9}
                tone={outcomeTone}
                label="settled"
              />
              <DonutChart
                segments={[
                  { key: "passed", label: "passed", value: composition.passed, tone: "success" },
                  { key: "failed", label: "failed", value: composition.failed, tone: "danger" },
                  { key: "blocked", label: "blocked", value: composition.blocked, tone: "warning" },
                  { key: "skipped", label: "skipped", value: composition.skipped, tone: "low" },
                  { key: "not_executed", label: "not executed", value: composition.notExecuted, tone: "mute" },
                ]}
                size={124}
                thickness={13}
                centerValue={run.testIds.length}
                centerLabel="cases"
                legend="column"
              />
            </div>
          </section>

          <section className={detail.panel}>
            <header className={detail.panelHead}>
              <h2 className={detail.panelTitle}>Categories scanned</h2>
              <span className={detail.panelNote}>
                {categories.length} categor{categories.length === 1 ? "y" : "ies"}
              </span>
            </header>
            {categories.length ? (
              <BarList
                items={categories.map((entry) => ({
                  key: entry.key,
                  label: entry.key,
                  value: entry.cases,
                  tone: entry.findings ? "high" : "accent",
                  hint: `${entry.cases} case${entry.cases === 1 ? "" : "s"} · ${
                    entry.findings
                  } finding${entry.findings === 1 ? "" : "s"}`,
                }))}
              />
            ) : (
              <p className={styles.activityEmpty}>
                The agent has not recorded a case for this run yet.
              </p>
            )}
          </section>
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

        <div className={styles.viewTabs}>
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`${styles.viewTab} ${tab === entry.key ? styles.viewTabActive : ""}`}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
              {entry.key === "findings" && activity.findings.length > 0 && (
                <span className={detail.tabBadge}>{activity.findings.length}</span>
              )}
              {entry.key === "log" && live && (
                <span className={styles.viewTabDot} aria-label="live" />
              )}
            </button>
          ))}
        </div>
      </header>

      {tab === "results" && (
        <div className={detail.results}>
          {activity.cases.length > 0 && (
            <div className={detail.resultsStrip}>
              <RunStrip cases={activity.cases} />
            </div>
          )}

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
                <span>
                  {testCase.findingIds.length ? (
                    <Link
                      href={
                        testCase.findingIds.length === 1
                          ? `/session/${sessionId}/vulnerabilities/${testCase.findingIds[0]}`
                          : `/session/${sessionId}/vulnerabilities`
                      }
                      className={styles.findingLink}
                    >
                      {testCase.findingIds.length} finding
                      {testCase.findingIds.length === 1 ? "" : "s"}
                    </Link>
                  ) : (
                    <span className={styles.caseDocMuted}>none</span>
                  )}
                </span>
              </div>
            ))}
            {!activity.cases.length && (
              <p className={styles.activityEmpty}>This scan has no recorded cases.</p>
            )}
          </div>
        </div>
      )}

      {tab === "findings" && (
        <div className={detail.results}>
          {activity.findings.length > 0 && (
            <div className={detail.resultsStrip}>
              <SeverityBar levels={findings.levels} />
            </div>
          )}

          <div className={styles.scanTable}>
            {activity.findings.length ? (
              <>
                <div className={styles.scanTableHead}>
                  <span>Finding</span>
                  <span>Severity</span>
                  <span>Case</span>
                </div>
                {findings.ranked.map((finding) => (
                  <div key={finding.vulnerabilityId} className={styles.scanTableRow}>
                    <span className={styles.scanIdentity}>
                      <Link
                        href={`/session/${sessionId}/vulnerabilities/${finding.vulnerabilityId}`}
                        className={styles.findingLink}
                      >
                        {finding.title}
                      </Link>
                      <span className={styles.scanMeta}>{finding.status}</span>
                    </span>
                    <span
                      className={`${vStyles.severity} ${vStyles[finding.severity] ?? ""}`}
                    >
                      {finding.severity}
                    </span>
                    <span className={styles.scanMeta}>{finding.testId || "—"}</span>
                  </div>
                ))}
              </>
            ) : (
              <p className={styles.activityEmpty}>
                {live
                  ? "The agent has not recorded a finding for this scan yet."
                  : "This scan recorded no findings."}
              </p>
            )}
          </div>
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
    </PageShell>
  );
}
