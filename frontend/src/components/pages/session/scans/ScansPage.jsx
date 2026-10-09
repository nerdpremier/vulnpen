"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Button, Input, Tooltip } from "antd";
import {
  DeleteOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { getScans, getTestPlan } from "@/services/websecurity.service";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { PageShell, PageState } from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
import { SEVERITY_LEVELS } from "@/utils/findings.mjs";
import { scansKey, testPlanKey } from "@/utils/scanQueryKeys.mjs";
import useScanMutations from "@/hooks/useScanMutations";
import {
  countScanCases,
  formatAgo,
  formatDuration,
  isScanLive,
  isUnrunCase,
  scanCaseStatuses,
  scanFindingTotal,
  scanFolderCounts,
  scanMatchesNeedle,
  scanName,
  scanPolicy,
  scanScopeLabel,
  scanStartedAt,
  scanStatusTone,
} from "@/utils/scans.mjs";
import { SCAN_STATUS_LABEL, ScanProgressBar } from "./ScanStatus";
import ScanLauncherModal from "./ScanLauncherModal";
import ScanTerrain from "./ScanTerrain";
import styles from "@/styles/pages/Scans.module.scss";

/**
 * The engagement's scans.
 *
 * The page opens on the history as one shape — a run per tower along a time
 * axis — then a ledger of the four numbers a reader arrives with, then the
 * records themselves: one row per run, live runs included, with their progress
 * in the row. A run is launched from the header, so the table stays a record
 * rather than a control panel.
 */

/** The status buckets the history is read through. */
const FOLDERS = [
  { value: "all", label: "All runs" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

/** How one case ended, and the palette key that says so. */
const CASE_OUTCOME = {
  passed: { label: "passed", tone: "success" },
  failed: { label: "failed", tone: "danger" },
  blocked: { label: "blocked", tone: "high" },
  skipped: { label: "skipped", tone: "mute" },
  in_progress: { label: "in progress", tone: "info" },
  not_started: { label: "not run", tone: "mute" },
};

const SEVERITY_LABEL = new Map(
  SEVERITY_LEVELS.map((level) => [level.key, level.label]),
);

const FINDING_COLUMNS = ["critical", "high", "medium", "low"];

/**
 * What a run's cases did.
 *
 * One case is answered with one word: a proportion bar over a single value is a
 * full-width rectangle that says nothing a word does not. From two cases up the
 * split is real data, so the bar comes back and its parts are named under it.
 */
function RunCases({ scan, planCases }) {
  const entries = scanCaseStatuses(scan, planCases);
  const counts = countScanCases(entries);

  if (counts.total <= 1) {
    const outcome = CASE_OUTCOME[entries[0]?.status] ?? CASE_OUTCOME.not_started;
    return (
      <span className={styles.caseWord} data-tone={outcome.tone}>
        <span className={styles.caseDot} aria-hidden="true" />
        {outcome.label}
      </span>
    );
  }

  const segments = [
    { key: "passed", value: counts.passed, label: "passed", tone: "success" },
    { key: "failed", value: counts.failed, label: "failed", tone: "danger" },
    { key: "blocked", value: counts.blocked, label: "blocked", tone: "high" },
    { key: "skipped", value: counts.skipped, label: "skipped", tone: "mute" },
    { key: "notExecuted", value: counts.notExecuted, label: "unrun", tone: "none" },
  ].filter((segment) => segment.value > 0);

  return (
    <span className={styles.runCases}>
      <span
        className={styles.caseTrack}
        role="img"
        aria-label={segments.map((s) => `${s.value} ${s.label}`).join(", ")}
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={styles.caseSeg}
            data-tone={segment.tone}
            style={{ flexGrow: segment.value }}
          />
        ))}
      </span>
      <span className={styles.caseWords}>
        {segments.map((segment) => (
          <span key={segment.key}>
            <b>{segment.value}</b> {segment.label}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A run's findings: one coloured number per severity, zeroes kept faint so the
 * columns line up across rows rather than reflowing as counts appear.
 */
function RunFindings({ scan }) {
  const counts = scan.findingCounts ?? null;

  if (!counts || scanFindingTotal(scan) === 0) {
    return (
      <span className={styles.findingsEmpty} title="No findings linked yet">
        —
      </span>
    );
  }

  const shown = counts.info ? [...FINDING_COLUMNS, "info"] : FINDING_COLUMNS;

  return (
    <span className={styles.findings} aria-label={`${scanFindingTotal(scan)} findings`}>
      {shown.map((key) => (
        <span
          key={key}
          className={styles.finding}
          data-tone={key}
          data-zero={!(counts[key] ?? 0) || undefined}
          title={`${SEVERITY_LABEL.get(key) ?? key}: ${counts[key] ?? 0}`}
        >
          {counts[key] ?? 0}
        </span>
      ))}
    </span>
  );
}

export default function ScansPage({ sessionId }) {
  const router = useRouter();
  const confirmPopUp = useConfirmPopUp();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [needle, setNeedle] = useState("");

  const scansQuery = useQuery(scansKey(sessionId), () => getScans(sessionId), {
    refetchInterval: (data) => ((data?.runs ?? []).some(isScanLive) ? 2000 : false),
  });

  const planLive = (scansQuery.data?.runs ?? []).some(isScanLive);
  const planQuery = useQuery(testPlanKey(sessionId), () => getTestPlan(sessionId), {
    refetchInterval: planLive ? 4000 : false,
  });

  const plan = planQuery.data?.plan ?? null;
  const planCases = useMemo(() => plan?.cases ?? [], [plan]);
  const scans = useMemo(() => scansQuery.data?.runs ?? [], [scansQuery.data]);

  const byStatus = useMemo(() => scanFolderCounts(scans), [scans]);

  const visibleScans = useMemo(
    () =>
      scans.filter(
        (scan) =>
          (statusFilter === "all" || scan.status === statusFilter) &&
          scanMatchesNeedle(scan, needle, planCases),
      ),
    [scans, statusFilter, needle, planCases],
  );

  const filtersActive = Boolean(needle.trim());
  const clearFilters = () => setNeedle("");

  const invalidate = () => {
    scansQuery.refetch();
    planQuery.refetch();
  };

  const { stop: stopMutation, remove: deleteMutation, launch: rerunMutation } =
    useScanMutations(sessionId);

  const openScan = (runId) => router.push(`/session/${sessionId}/scans/${runId}`);

  const confirmDelete = (scan) =>
    confirmPopUp({
      title: `Delete “${scanName(scan, planCases)}”?`,
      content:
        "The scan disappears from the history. The results it recorded stay on the test plan and its findings stay on the Vulnerabilities page.",
      okText: "Delete",
      onOk: () => deleteMutation.mutateAsync(scan.runId),
    });

  const confirmStop = (scan) => {
    const counts = countScanCases(scanCaseStatuses(scan, planCases));
    const remaining = counts.notExecuted;
    confirmPopUp({
      title: `Stop “${scanName(scan, planCases)}”?`,
      content: remaining
        ? `${remaining} of its ${counts.total} case${counts.total === 1 ? "" : "s"} have no result yet. Stopping ends the run for good — it cannot be resumed, and those cases stay unexecuted until you scan again.`
        : "The run ends immediately and cannot be resumed.",
      okText: "Stop scan",
      onOk: () => stopMutation.mutateAsync(scan.runId),
    });
  };

  const runAgain = (scan) =>
    rerunMutation.mutate({
      testIds: scan.testIds,
      label: `${scanName(scan, planCases)} (retest)`,
      policy: scanPolicy(scan),
      sourceRunId: scan.runId,
      onLaunched: (run) => {
        if (run?.runId) openScan(run.runId);
      },
    });

  /* The page's actions ride in the app header, on the same row as the
     engagement's breadcrumb, so the body opens on the history itself. The set
     matches every session page: reload, the agent's chat, and the page's own
     primary action. */
  const actions = useMemo(
    () => (
      <>
        <Tooltip title="Reload the scan history">
          <Button
            icon={<ReloadOutlined />}
            onClick={invalidate}
            aria-label="Reload the scan history"
          />
        </Tooltip>
        <Button
          icon={<MessageOutlined />}
          onClick={() => router.push(`/session/${sessionId}/chat`)}
        >
          Agent chat
        </Button>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          disabled={!planCases.length}
          onClick={() => setLauncherOpen(true)}
        >
          New scan
        </Button>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planCases.length, sessionId, router],
  );
  usePublishHeaderActions(actions);

  const shell = (children) => (
    <PageShell>
      {children}
      {launcherOpen && (
        <ScanLauncherModal
          sessionId={sessionId}
          plan={plan}
          onClose={() => setLauncherOpen(false)}
          onLaunched={(run) => {
            setLauncherOpen(false);
            if (run?.runId) openScan(run.runId);
          }}
        />
      )}
    </PageShell>
  );

  if (planQuery.isLoading || scansQuery.isLoading) {
    return shell(<PageState state="loading" rows={5} />);
  }

  if (planQuery.isError || scansQuery.isError) {
    return shell(
      <PageState
        state="error"
        title="Could not load the scan history"
        description="The scans, or the plan they run against, could not be read. Retry before launching a new one."
        onRetry={invalidate}
      />,
    );
  }

  if (!planCases.length) {
    return shell(
      <PageState
        state="empty"
        title="No test plan yet"
        description="A scan runs the cases the plan selects, so the plan comes first."
        actions={
          <Button type="primary" onClick={() => router.push(`/session/${sessionId}/test-plan`)}>
            Build the test plan
          </Button>
        }
      />,
    );
  }

  if (!scans.length) {
    const caseCount = planCases.filter(isUnrunCase).length || planCases.length;
    return shell(
      <PageState
        state="empty"
        title="No scans yet"
        description={`A scan runs ${caseCount} case${
          caseCount === 1 ? "" : "s"
        } against ${plan?.target || "the target"} and records the outcome on the plan.`}
        actions={
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setLauncherOpen(true)}>
            Launch the first scan
          </Button>
        }
      />,
    );
  }

  /* The four numbers a reader arrives with, each stated once. */
  const running = byStatus.get("running") ?? 0;
  const completed = byStatus.get("completed") ?? 0;
  const failed = byStatus.get("failed") ?? 0;

  const ledger = [
    { key: "runs", label: "Runs", value: scans.length, tone: "plain" },
    { key: "running", label: "Running", value: running, tone: "info" },
    { key: "completed", label: "Completed", value: completed, tone: "success" },
    { key: "failed", label: "Failed", value: failed, tone: "danger" },
  ];

  return shell(
    <>
      <header className={styles.pageHead}>
        <span className={styles.eyebrow}>Engagement</span>
        <h1>Scans</h1>
      </header>

      {/* Two columns: the history as one shape on the left — a radar scope
          where each run is a blip, near for recent and far for old — and the
          records themselves on the right. */}
      <div className={styles.layout}>
        <aside className={styles.stagePanel} aria-label="Run scope">
          <div className={styles.stage}>
            <ScanTerrain
              scans={visibleScans}
              planCases={planCases}
              className={styles.terrainCanvas}
              onPick={(scan) => openScan(scan.runId)}
            />
          </div>
          <div className={styles.stageLedger}>
            {ledger.map((item) => (
              <div key={item.key} className={styles.ledgerItem} data-tone={item.tone}>
                <span className={styles.ledgerValue}>{item.value}</span>
                <span className={styles.ledgerLabel}>{item.label}</span>
              </div>
            ))}
          </div>
          <div className={styles.stageKey} aria-hidden="true">
            <span><i className={styles.keyDot} data-tone="completed" />completed</span>
            <span><i className={styles.keyDot} data-tone="failed" />failed</span>
            <span><i className={styles.keyDot} data-tone="running" />running</span>
            <span><i className={styles.keyDot} data-tone="cancelled" />cancelled</span>
          </div>
        </aside>

        {/* The records — the filter, then one row per run. */}
        <div className={styles.records}>
          <div className={styles.controls}>
            <nav className={styles.folders} aria-label="Run status">
              {FOLDERS.map((folder) => {
                const count =
                  folder.value === "all" ? scans.length : byStatus.get(folder.value) ?? 0;
                return (
                  <button
                    key={folder.value}
                    type="button"
                    className={styles.folder}
                    data-active={statusFilter === folder.value || undefined}
                    aria-current={statusFilter === folder.value ? "true" : undefined}
                    onClick={() => setStatusFilter(folder.value)}
                  >
                    <span className={styles.folderLabel}>{folder.label}</span>
                    <span className={styles.folderCount}>{count}</span>
                  </button>
                );
              })}
            </nav>

            <Input
              prefix={<SearchOutlined />}
              placeholder="Search run, case or error"
              value={needle}
              onChange={(event) => setNeedle(event.target.value)}
              allowClear
              className={styles.search}
              aria-label="Search runs"
            />
            {filtersActive && (
              <Button size="small" type="text" onClick={clearFilters}>
                Clear
              </Button>
            )}
          </div>

          <section className={styles.table} aria-label="Scan records">
            <div className={styles.head} aria-hidden="true">
              <span>Run</span>
              <span>Cases</span>
              <span>Status</span>
              <span>Findings</span>
              <span>When</span>
              <span />
            </div>

            {visibleScans.map((scan) => {
              const live = isScanLive(scan);
              const queued = scan.status === "queued";
              const startedAt = scanStartedAt(scan);
              const caseCount = (scan.testIds ?? []).length;
              const scope = caseCount > 1 ? scanScopeLabel(scan, planCases) : "";

              return (
                <div
                  key={scan.runId}
                  className={styles.row}
                  data-live={live || undefined}
                  onClick={(event) => {
                    if (event.target.closest("a, button")) return;
                    openScan(scan.runId);
                  }}
                >
                  <span className={styles.identity}>
                    <Link
                      href={`/session/${sessionId}/scans/${scan.runId}`}
                      className={styles.name}
                    >
                      {scanName(scan, planCases)}
                    </Link>
                    {scope && (
                      <span className={styles.scope} title={scope}>
                        {scope}
                      </span>
                    )}
                  </span>

                  <RunCases scan={scan} planCases={planCases} />

                  <span className={styles.stateCell}>
                    <span className={styles.runState} data-tone={scanStatusTone(scan.status)}>
                      <span className={styles.runDot} aria-hidden="true" />
                      {SCAN_STATUS_LABEL[scan.status] ?? scan.status}
                    </span>
                    {queued && (
                      <span className={styles.queueNote}>
                        {scan.position > 1 ? `#${scan.position} in the queue` : "waiting to start"}
                      </span>
                    )}
                    {scan.status === "running" && (
                      <ScanProgressBar
                        testIds={scan.testIds}
                        planCases={planCases}
                        since={scan.startedAt}
                      />
                    )}
                  </span>

                  <RunFindings scan={scan} />

                  <span className={styles.when}>
                    <span
                      className={styles.whenTop}
                      title={startedAt ? new Date(startedAt).toLocaleString() : undefined}
                    >
                      {formatAgo(startedAt)}
                    </span>
                    <span className={styles.whenSub}>
                      {scan.durationMs != null ? formatDuration(scan.durationMs) : "—"}
                    </span>
                  </span>

                  <span className={styles.rowActions}>
                    {live ? (
                      <Tooltip title="Stop this run">
                        <button
                          type="button"
                          className={styles.iconBtn}
                          data-variant="stop"
                          aria-label={`Stop ${scanName(scan, planCases)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            confirmStop(scan);
                          }}
                        >
                          <StopOutlined />
                        </button>
                      </Tooltip>
                    ) : (
                      <>
                        <Tooltip title="Run these cases again">
                          <button
                            type="button"
                            className={styles.iconBtn}
                            aria-label={`Run ${scanName(scan, planCases)} again`}
                            onClick={(event) => {
                              event.stopPropagation();
                              runAgain(scan);
                            }}
                          >
                            <RedoOutlined />
                          </button>
                        </Tooltip>
                        <Tooltip title="Delete this run">
                          <button
                            type="button"
                            className={styles.iconBtn}
                            data-variant="danger"
                            aria-label={`Delete ${scanName(scan, planCases)}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              confirmDelete(scan);
                            }}
                          >
                            <DeleteOutlined />
                          </button>
                        </Tooltip>
                      </>
                    )}
                  </span>
                </div>
              );
            })}

            {visibleScans.length === 0 && (
              <div className={styles.noMatch}>
                <p>No run matches this filter{filtersActive ? " and search" : ""}.</p>
                <Button size="small" onClick={clearFilters}>
                  Clear search
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
    </>,
  );
}
