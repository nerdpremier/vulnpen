"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Button, Input, Tooltip } from "antd";
import {
  DeleteOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { getScans, getTestPlan } from "@/services/websecurity.service";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { PageHeader, PageShell, PageState, TimelineChart } from "@/components/common/ui";
import { SEVERITY_LEVELS } from "@/utils/findings.mjs";
import { scansKey, testPlanKey } from "@/utils/scanQueryKeys.mjs";
import useScanMutations from "@/hooks/useScanMutations";
import {
  countScanCases,
  formatAgo,
  formatDuration,
  formatStamp,
  isScanLive,
  isUnrunCase,
  scanCaseStatuses,
  scanFailureGroups,
  scanFindingTotal,
  scanFolderCounts,
  scanMatchesNeedle,
  scanName,
  scanPolicy,
  scanScopeLabel,
  scanStartedAt,
  scanStatusTone,
  scanTimeline,
} from "@/utils/scans.mjs";
import { SCAN_STATUS_LABEL, ScanProgressBar } from "./ScanStatus";
import ScanLauncherModal from "./ScanLauncherModal";
import styles from "@/styles/pages/Scans.module.scss";

/**
 * The session's scans, laid out the way Tenable's scans page is: a folder rail
 * on the left, one table behind it that carries every scan — the live ones
 * show their progress in the row, like Nessus does — and a New scan button
 * that opens the case picker. The engine behind the table is the session's AI
 * agent working the plan's cases; the page never prompts for it.
 */

/** The folder rail: one folder per status the history can hold. */
const FOLDERS = [
  { value: "all", label: "My Scans" },
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

/** The severity columns the findings cell shows, highest risk first. */
const FINDING_COLUMNS = ["critical", "high", "medium", "low"];

/**
 * What the scan's cases did.
 *
 * One case is answered with one word - a proportion bar over a single value is
 * a full-width green rectangle that says nothing a word does not, and it lies
 * about size: "1 passed" and "10 passed" drew the same bar. From two cases up
 * the split is real data, so the bar comes back and the counts sit under it.
 */
function ScanCases({ scan, planCases }) {
  const entries = scanCaseStatuses(scan, planCases);
  const counts = countScanCases(entries);

  if (counts.total <= 1) {
    const outcome = CASE_OUTCOME[entries[0]?.status] ?? CASE_OUTCOME.not_started;
    return (
      <span className={styles.outcome} data-tone={outcome.tone}>
        <span className={styles.outcomeDot} aria-hidden="true" />
        {outcome.label}
      </span>
    );
  }

  const segments = [
    { key: "passed", value: counts.passed, label: "passed", tone: "success" },
    { key: "failed", value: counts.failed, label: "failed", tone: "danger" },
    { key: "blocked", value: counts.blocked, label: "blocked", tone: "high" },
    { key: "skipped", value: counts.skipped, label: "skipped", tone: "mute" },
    {
      key: "notExecuted",
      value: counts.notExecuted,
      label: "not executed",
      tone: "none",
    },
  ].filter((segment) => segment.value > 0);

  return (
    <span className={styles.cases}>
      <span
        className={styles.caseTrack}
        role="img"
        aria-label={segments
          .map((segment) => `${segment.value} ${segment.label}`)
          .join(", ")}
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
 * The findings column, Nessus's "Vulnerabilities Found": one coloured number
 * per severity. Zeroes stay visible but faint, so the columns line up across
 * rows instead of reflowing as counts appear.
 */
function ScanFindings({ scan }) {
  const counts = scan.findingCounts ?? null;

  if (!counts || scanFindingTotal(scan) === 0) {
    return (
      <span className={styles.findingsEmpty} title="No findings linked yet">
        —
      </span>
    );
  }

  const shown = counts.info
    ? [...FINDING_COLUMNS, "info"]
    : FINDING_COLUMNS;

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

  const scansQuery = useQuery(scansKey(sessionId), () => getScans(sessionId), {
    refetchInterval: (data) =>
      (data?.runs ?? []).some(isScanLive) ? 2000 : false,
  });

  // The plan is the live source of per-case status, so the list polls it too
  // while a scan runs — otherwise every progress bar freezes at page-open.
  const planLive = (scansQuery.data?.runs ?? []).some(isScanLive);
  const planQuery = useQuery(
    testPlanKey(sessionId),
    () => getTestPlan(sessionId),
    { refetchInterval: planLive ? 4000 : false },
  );

  const plan = planQuery.data?.plan ?? null;
  const planCases = useMemo(() => plan?.cases ?? [], [plan]);
  const scans = useMemo(() => scansQuery.data?.runs ?? [], [scansQuery.data]);
  const timeline = useMemo(
    () => scanTimeline(scans, { limit: 8, planCases }),
    [scans, planCases],
  );

  const [statusFilter, setStatusFilter] = useState("all");
  const [needle, setNeedle] = useState("");

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

  /* The reasons, counted once in scans.mjs: the notice says why runs stopped,
     and how many of them it happened to. */
  const failureGroups = useMemo(() => scanFailureGroups(scans), [scans]);
  const stoppedEarly = failureGroups.reduce(
    (total, group) => total + group.count,
    0,
  );

  const invalidate = () => {
    scansQuery.refetch();
    planQuery.refetch();
  };

  const { stop: stopMutation, remove: deleteMutation, launch: rerunMutation } =
    useScanMutations(sessionId);

  const openScan = (runId) => router.push(`/session/${sessionId}/scans/${runId}`);
  const scanHref = (runId) => `/session/${sessionId}/scans/${runId}`;

  const confirmDelete = (scan) =>
    confirmPopUp({
      title: `Delete “${scanName(scan, planCases)}”?`,
      content:
        "The scan disappears from the history. The results it recorded stay on the test plan and its findings stay on the Vulnerabilities page.",
      okText: "Delete",
      onOk: () => deleteMutation.mutateAsync(scan.runId),
    });

  /**
   * Stopping aborts the agent mid-run and a stopped scan cannot be resumed, so
   * it says how much work would be thrown away before it does it.
   */
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

  const header = (
    <PageHeader
      eyebrow="Engagement"
      title="Scans"
      description="A scan works through the cases the plan selects on its own — no prompt to write, no step to trigger."
      actions={
        <>
          <Tooltip title="Reload the scan history">
            <Button
              icon={<ReloadOutlined />}
              onClick={invalidate}
              aria-label="Reload the scan history"
            />
          </Tooltip>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!planCases.length}
            onClick={() => setLauncherOpen(true)}
          >
            New scan
          </Button>
        </>
      }
    />
  );

  const shell = (children) => (
    <PageShell>
      {header}
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
          <Button
            type="primary"
            onClick={() => router.push(`/session/${sessionId}/test-plan`)}
          >
            Build the test plan
          </Button>
        }
      />,
    );
  }

  if (!scans.length) {
    const caseCount =
      planCases.filter(isUnrunCase).length || planCases.length;
    return shell(
      <PageState
        state="empty"
        title="No scans yet"
        description={`A scan runs ${caseCount} case${
          caseCount === 1 ? "" : "s"
        } against ${plan?.target || "the target"} and records the outcome on the plan.`}
        actions={
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => setLauncherOpen(true)}
          >
            Launch the first scan
          </Button>
        }
      />,
    );
  }

  /**
   * One scan, one row — the way Nessus draws its history. A live scan stays in
   * this table: its status cell carries the progress bar (or the queue slot),
   * and its action is Stop. A settled one carries Run again and Delete.
   */
  const renderRow = (scan) => {
    const live = isScanLive(scan);
    const queued = scan.status === "queued";
    const startedAt = scanStartedAt(scan);
    const caseCount = (scan.testIds ?? []).length;
    /* The category line earns its place only when there is more than one case:
       "INFO ×1" under a name that already is that one case is a second line of
       punctuation. */
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
          <Link href={scanHref(scan.runId)} className={styles.name}>
            {scanName(scan, planCases)}
          </Link>
          {scope && (
            <span className={styles.scope} title={scope}>
              {scope}
            </span>
          )}
        </span>

        <ScanCases scan={scan} planCases={planCases} />

        <span className={styles.stateCell}>
          <span
            className={styles.runState}
            data-tone={scanStatusTone(scan.status)}
          >
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

        <ScanFindings scan={scan} />

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
            <Tooltip title="Stop this scan">
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
              <Tooltip title="Delete this scan">
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
  };

  return shell(
    <div className={styles.layout}>
      <nav className={styles.folders} aria-label="Scan folders">
        {FOLDERS.map((folder) => {
          const count =
            folder.value === "all"
              ? scans.length
              : byStatus.get(folder.value) ?? 0;
          return (
            <button
              key={folder.value}
              type="button"
              className={styles.folder}
              data-active={statusFilter === folder.value || undefined}
              aria-current={statusFilter === folder.value ? "page" : undefined}
              onClick={() => setStatusFilter(folder.value)}
            >
              <span className={styles.folderLabel}>{folder.label}</span>
              <span className={styles.folderCount}>{count}</span>
            </button>
          );
        })}
      </nav>

      <section className={styles.panel} aria-label="Scan history">
        <div className={styles.bar}>
          <span className={styles.barTitle}>
            {statusFilter === "all" ? "All scans" : SCAN_STATUS_LABEL[statusFilter]}
            <span className={styles.count}>{visibleScans.length}</span>
            {filtersActive && (
              <span className={styles.barNote}>{scans.length} total</span>
            )}
          </span>
          <span className={styles.barSpacer} />
          <Input
            prefix={<SearchOutlined />}
            placeholder="Search scan, case or error"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            allowClear
            className={styles.search}
            aria-label="Search scans"
          />
          {filtersActive && (
            <Button size="small" type="text" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>

        {timeline.rows.length > 1 && (
          <div className={styles.timelinePanel} aria-label="Recent scan activity">
            <div className={styles.timelineHeading}>
              <span>RECENT RUNS</span>
              <span>Last {timeline.rows.length} of {scans.length} · all statuses</span>
            </div>
            <TimelineChart
              items={timeline.rows.map((row) => ({
                ...row,
                description: `${row.title} · started ${new Date(row.start).toLocaleString()} · span ${formatDuration(row.end - row.start)}`,
              }))}
              startLabel={formatStamp(timeline.start)}
              endLabel={formatStamp(timeline.end)}
            />
          </div>
        )}

        {/* Same sentence, counted once. The row keeps the fact that it stopped;
            this says why, and how many runs it happened to. */}
        {failureGroups.length > 0 && (
          <div className={styles.notice}>
            <span className={styles.noticeLabel}>
              {stoppedEarly} of {scans.length} runs stopped before finishing
            </span>
            {failureGroups.map((group) => (
              <span
                key={group.reason}
                className={styles.noticeRow}
                title={group.reason}
              >
                <span className={styles.noticeCount}>{group.count}×</span>
                <span className={styles.noticeText}>{group.reason}</span>
              </span>
            ))}
          </div>
        )}

        <div className={styles.table}>
          <div className={styles.head} aria-hidden="true">
            <span>Scan</span>
            <span>Cases</span>
            <span>Status</span>
            <span>Findings</span>
            <span>Last executed</span>
            <span />
          </div>
          {visibleScans.map(renderRow)}
        </div>

        {visibleScans.length === 0 && (
          <div className={styles.noMatch}>
            <p>No scan matches this folder{filtersActive ? " and search" : ""}.</p>
            <Button size="small" onClick={clearFilters}>
              Clear search
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
