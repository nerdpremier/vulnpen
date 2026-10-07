"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { App, Button, Input, Select, Tooltip } from "antd";
import {
  DeleteOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { deleteScan, getScans, getTestPlan, stopScan } from "@/services/websecurity.service";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { PageHeader, PageShell, PageState, TimelineChart } from "@/components/common/ui";
import { apiErrorMessage } from "@/utils/apiError";
import {
  countScanCases,
  formatAgo,
  formatDuration,
  isScanLive,
  scanCaseStatuses,
  scanName,
  scanScopeLabel,
  scanStartedAt,
  scanStatusTone,
  scanTimeline,
} from "@/utils/scans.mjs";
import { SCAN_STATUS_LABEL, ScanProgressBar } from "./ScanStatus";
import ScanLauncherModal from "./ScanLauncherModal";
import styles from "@/styles/pages/Scans.module.scss";

/** Worst news last, so the option list reads like the history it filters. */
const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
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
 * The session's scans - the page is the list.
 *
 * A scan that is still moving gets its own card at the top of that list, with
 * the progress bar and the Stop button on it; a settled scan is one row. What
 * the rows deliberately do *not* carry is the failure text: twelve runs that
 * died of the same rate limit printed that same sentence twelve times and
 * buried everything else, so identical reasons are counted once, above the
 * list, and the row says only that the run stopped.
 */
export default function ScansPage({ sessionId }) {
  const router = useRouter();
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const queryClient = useQueryClient();
  const [launcherOpen, setLauncherOpen] = useState(false);

  const scansQuery = useQuery(["scans", sessionId], () => getScans(sessionId), {
    refetchInterval: (data) =>
      (data?.runs ?? []).some(isScanLive) ? 2000 : false,
  });

  // The plan is the live source of per-case status, so the list polls it too
  // while a scan runs — otherwise every progress bar freezes at page-open.
  const planLive = (scansQuery.data?.runs ?? []).some(isScanLive);
  const planQuery = useQuery(["test-plan", sessionId], () => getTestPlan(sessionId), {
    refetchInterval: planLive ? 4000 : false,
  });

  const plan = planQuery.data?.plan ?? null;
  const planCases = useMemo(() => plan?.cases ?? [], [plan]);
  const scans = useMemo(() => scansQuery.data?.runs ?? [], [scansQuery.data]);
  const timeline = useMemo(
    () => scanTimeline(scans, { limit: 8, planCases }),
    [scans, planCases],
  );

  const [statusFilter, setStatusFilter] = useState("all");
  const [needle, setNeedle] = useState("");

  const byStatus = useMemo(() => {
    const counts = new Map();
    for (const scan of scans) {
      counts.set(scan.status, (counts.get(scan.status) ?? 0) + 1);
    }
    return counts;
  }, [scans]);

  /* Only the statuses this history actually contains, each with its count: an
     option that can only ever return nothing is a dead end in a filter. */
  const filterOptions = useMemo(
    () =>
      STATUS_FILTERS.filter(
        (option) => option.value === "all" || byStatus.get(option.value),
      ).map((option) => ({
        value: option.value,
        label:
          option.value === "all"
            ? `${option.label} (${scans.length})`
            : `${option.label} (${byStatus.get(option.value)})`,
      })),
    [byStatus, scans.length],
  );

  /* The reasons, counted. Two runs that died of the same sentence are one line;
     a run that died of its own reason still gets its line, with a count of one. */
  const failureGroups = useMemo(() => {
    const groups = new Map();
    for (const scan of scans) {
      if (scan.status !== "failed" && scan.status !== "cancelled") continue;
      const reason = (scan.error ?? "").trim();
      const key = reason || "The run stopped without recording a reason.";
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return [...groups.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => ({ reason, count }));
  }, [scans]);

  const stoppedEarly = failureGroups.reduce(
    (total, group) => total + group.count,
    0,
  );

  const visibleScans = useMemo(() => {
    const query = needle.trim().toLowerCase();
    return scans.filter((scan) => {
      if (statusFilter !== "all" && scan.status !== statusFilter) return false;
      if (!query) return true;
      return [scanName(scan, planCases), scan.error, scan.status, ...(scan.testIds ?? [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [scans, statusFilter, needle, planCases]);

  const live = useMemo(() => visibleScans.filter(isScanLive), [visibleScans]);
  const settled = useMemo(
    () => visibleScans.filter((scan) => !isScanLive(scan)),
    [visibleScans],
  );

  const filtersActive = statusFilter !== "all" || Boolean(needle.trim());
  const clearFilters = () => {
    setStatusFilter("all");
    setNeedle("");
  };

  /* The band's label is the one place the page would otherwise call a queued
     scan "running". */
  const liveLabel = useMemo(() => {
    if (!live.length) return "";
    const running = live.filter((scan) => scan.status === "running").length;
    if (running === live.length) {
      return live.length === 1 ? "Running now" : `${live.length} running now`;
    }
    if (running === 0) {
      return live.length === 1 ? "Queued" : `${live.length} queued`;
    }
    return `${running} running · ${live.length - running} queued`;
  }, [live]);

  const notExecuted = planCases.filter(
    (testCase) => testCase.status === "not_started" || testCase.status === "in_progress",
  );

  const invalidate = () => {
    queryClient.invalidateQueries(["scans", sessionId]);
    queryClient.invalidateQueries(["test-plan", sessionId]);
  };

  const stopMutation = useMutation((runId) => stopScan(sessionId, runId), {
    onSuccess: invalidate,
    onError: (error) => message.error(apiErrorMessage(error, "Could not stop the scan")),
  });

  const deleteMutation = useMutation((runId) => deleteScan(sessionId, runId), {
    onSuccess: (_data, runId) => {
      // Drop the detail cache too: a settled scan's poll has stopped, so a
      // Browser-Back to it would otherwise re-render the deleted record.
      queryClient.removeQueries(["scan", sessionId, runId]);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not delete the scan")),
  });

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
    const settledCount = counts.total - counts.notExecuted;
    const remaining = counts.total - settledCount;
    confirmPopUp({
      title: `Stop “${scanName(scan, planCases)}”?`,
      content: remaining
        ? `${remaining} of its ${counts.total} case${counts.total === 1 ? "" : "s"} have no result yet. Stopping ends the run for good — it cannot be resumed, and those cases stay unexecuted until you scan again.`
        : "The run ends immediately and cannot be resumed.",
      okText: "Stop scan",
      onOk: () => stopMutation.mutateAsync(scan.runId),
    });
  };

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
    const caseCount = notExecuted.length || planCases.length;
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

  /** A scan that is still moving: its progress is the page's live element. */
  const renderLive = (scan) => {
    const startedAt = scanStartedAt(scan);
    const queued = scan.status === "queued";
    const where = queued
      ? scan.position > 1
        ? `#${scan.position} in the queue`
        : "waiting to start"
      : startedAt
        ? `started ${formatAgo(startedAt)}`
        : "started";

    return (
      <div key={scan.runId} className={styles.liveCard}>
        <div className={styles.liveTop}>
          {/* The card owns the state here: the border of a pill inside a
              bordered card is a box in a box, and the LED plus the word below
              already say which state this is. */}
          <span
            className={styles.liveDot}
            data-state={queued ? "queued" : "running"}
            aria-hidden="true"
          />
          <Link href={scanHref(scan.runId)} className={styles.liveName}>
            {scanName(scan, planCases)}
          </Link>
          <span className={styles.liveSpacer} />
          <Button size="small" onClick={() => openScan(scan.runId)}>
            Open
          </Button>
          <Tooltip title="Stop this scan">
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              aria-label={`Stop ${scanName(scan, planCases)}`}
              loading={
                stopMutation.isLoading && stopMutation.variables === scan.runId
              }
              onClick={() => confirmStop(scan)}
            />
          </Tooltip>
        </div>

        <ScanProgressBar
          testIds={scan.testIds}
          planCases={planCases}
          since={scan.startedAt}
        />

        <div className={styles.liveMeta}>
          <span className={styles.liveState} data-state={queued ? "queued" : "running"}>
            {queued ? "Queued" : "Running"}
          </span>
          <span className={styles.liveMetaDot} aria-hidden="true" />
          <span>{scanScopeLabel(scan, planCases)}</span>
          <span className={styles.liveMetaDot} aria-hidden="true" />
          <span>{where}</span>
        </div>
      </div>
    );
  };

  /**
   * One settled scan: the case it ran (its own name), what that case did, how
   * the run ended, and when. The name is the real link; the row click is a
   * mouse shortcut that stands down for anything interactive inside it.
   */
  const renderRow = (scan) => {
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

        <span
          className={styles.runState}
          data-tone={scanStatusTone(scan.status)}
        >
          <span className={styles.runDot} aria-hidden="true" />
          {SCAN_STATUS_LABEL[scan.status] ?? scan.status}
        </span>

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
          <Tooltip title="Delete this scan">
            <button
              type="button"
              className={styles.deleteBtn}
              aria-label={`Delete ${scanName(scan, planCases)}`}
              onClick={(event) => {
                event.stopPropagation();
                confirmDelete(scan);
              }}
            >
              <DeleteOutlined />
            </button>
          </Tooltip>
        </span>
      </div>
    );
  };

  return shell(
    <section className={styles.list} aria-label="Scan history">
      <div className={styles.bar}>
        <span className={styles.barTitle}>
          Scans
          <span className={styles.count}>{scans.length}</span>
          {filtersActive && (
            <span className={styles.barNote}>{visibleScans.length} matching</span>
          )}
        </span>
        <span className={styles.barSpacer} />
        {scans.length > 1 && (
          <>
            <Input
              prefix={<SearchOutlined />}
              placeholder="Search scan, case or error"
              value={needle}
              onChange={(event) => setNeedle(event.target.value)}
              allowClear
              className={styles.search}
              aria-label="Search scans"
            />
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              className={styles.filter}
              aria-label="Filter scans by status"
              options={filterOptions}
            />
            {filtersActive && (
              <Button size="small" type="text" onClick={clearFilters}>
                Clear
              </Button>
            )}
          </>
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
            startLabel={new Date(timeline.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            endLabel={new Date(timeline.end).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
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

      {live.length > 0 && (
        <div className={styles.liveBlock} aria-live="polite">
          <span className={styles.liveLabel}>{liveLabel}</span>
          {live.map(renderLive)}
        </div>
      )}

      {settled.length > 0 && (
        <>
          <div className={styles.head} aria-hidden="true">
            <span>Scan</span>
            <span>Cases</span>
            <span>Run</span>
            <span>Started</span>
            <span />
          </div>
          {settled.map(renderRow)}
        </>
      )}

      {visibleScans.length === 0 && (
        <div className={styles.noMatch}>
          <p>No scan matches these filters.</p>
          <Button size="small" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}
    </section>,
  );
}
