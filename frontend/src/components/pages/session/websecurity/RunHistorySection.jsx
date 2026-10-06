"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { App, Button, Tooltip } from "antd";
import {
  CaretDownOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  MinusCircleFilled,
  PauseCircleFilled,
  PlayCircleFilled,
  StopOutlined,
} from "@ant-design/icons";
import { cancelTestRun, getTestRuns, stopTestRun } from "@/services/websecurity.service";
import { connectAgentStream } from "@/services/agent.service";
import { useAgentStreamStore } from "@/store/agentStream.store";
import useRunActivity from "@/hooks/useRunActivity";
import RunActivityStream from "./RunActivityStream";
import { apiErrorMessage } from "@/utils/apiError";
import {
  describeRunResult,
  formatDuration,
  runProgressFromPlan,
} from "@/utils/runs.mjs";
import styles from "@/styles/pages/TestPlan.module.scss";

const STATUS_TONE = {
  queued: styles.runToneQueued,
  running: styles.runToneRunning,
  completed: styles.runToneCompleted,
  failed: styles.runToneFailed,
  cancelled: styles.runToneCancelled,
};

const STATUS_ICON = {
  queued: <PauseCircleFilled />,
  running: <PlayCircleFilled />,
  completed: <CheckCircleFilled />,
  failed: <CloseCircleFilled />,
  cancelled: <MinusCircleFilled />,
};

const STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function RunProgress({ progress }) {
  return (
    <span className={styles.runProgress}>
      <span className={styles.runProgressTrack}>
        <span
          className={styles.runProgressFill}
          style={{ width: `${progress.percent}%` }}
        />
      </span>
      <span className={styles.runProgressText}>
        {progress.percent}% ({progress.done}/{progress.total})
      </span>
    </span>
  );
}

/**
 * The Nessus-style scan history for this case: every launch is a row with a
 * lifecycle (queued → running → completed/failed/cancelled), live progress,
 * and an expandable AI activity stream. The row of the run that currently
 * owns the case expands by itself.
 */
export default function RunHistorySection({ sessionId, testCase, planCases }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState(null);
  const consentControllerRef = useRef(null);

  const runsQuery = useQuery(["test-runs", sessionId], () => getTestRuns(sessionId), {
    refetchInterval: (data) =>
      (data?.runs ?? []).some(
        (run) => run.status === "queued" || run.status === "running",
      )
        ? 2000
        : false,
  });
  const runs = runsQuery.data?.runs ?? [];

  const activeRun =
    runs.find(
      (run) =>
        (run.status === "queued" || run.status === "running") &&
        (run.testIds ?? []).includes(testCase.testId),
    ) ?? null;

  // The run that owns the case right now expands itself, like Nessus jumping
  // to the running scan.
  useEffect(() => {
    if (activeRun) setExpandedId(activeRun.runId);
  }, [activeRun?.runId]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries(["test-runs", sessionId]);
    queryClient.invalidateQueries(["test-plan", sessionId]);
    // The run persisted chat messages; the chat page reloads its stale store.
    useAgentStreamStore.getState().markHistoryStale?.(sessionId);
  }, [queryClient, sessionId]);

  const stopMutation = useMutation(
    (runId) => stopTestRun(sessionId, runId),
    { onSuccess: invalidate },
  );
  const cancelMutation = useMutation(
    (runId) => cancelTestRun(sessionId, runId),
    { onSuccess: invalidate },
  );

  // Approval goes through the same consent stream endpoint the chat uses; the
  // continuation is persisted server-side, this page follows it by polling.
  const handleConsent = useCallback(
    (approved) => {
      connectAgentStream({
        sessionId,
        message: JSON.stringify({ approved }),
        endpoint: "consent",
      })
        .then((controller) => {
          consentControllerRef.current = controller;
        })
        .catch(() => {});
    },
    [sessionId],
  );

  const expandedRun = runs.find((run) => run.runId === expandedId) ?? null;

  if (!runsQuery.isLoading && !runs.length) {
    return (
      <section className={styles.runsSection}>
        <div className={styles.runList}>
          <div className={styles.runsCardHeader}>
            <h2 className={styles.runsTitle}>Runs</h2>
            <span className={styles.runsCount}>0</span>
          </div>
          <div className={styles.runsEmpty}>
            This case has never been run. Press Run to let the agent execute it.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.runsSection}>
      <div className={styles.runList}>
        <div className={styles.runsCardHeader}>
          <h2 className={styles.runsTitle}>Runs</h2>
          <span className={styles.runsCount}>{runs.length}</span>
        </div>
        {runs.map((run) => {
          const active = run.status === "queued" || run.status === "running";
          const progress = runProgressFromPlan(run.testIds, planCases);
          const expanded = run.runId === expandedId;
          return (
            <div key={run.runId} className={styles.runRowWrap}>
              <button
                type="button"
                className={`${styles.runRow} ${expanded ? styles.runRowOpen : ""}`}
                onClick={() => setExpandedId(expanded ? null : run.runId)}
              >
                <span className={`${styles.runStatusPill} ${STATUS_TONE[run.status]}`}>
                  {STATUS_ICON[run.status]} {STATUS_LABEL[run.status] ?? run.status}
                </span>

                {run.status === "queued" && run.position > 1 && (
                  <span className={styles.runQueuedNote}>#{run.position} in queue</span>
                )}

                {active ? (
                  <RunProgress progress={progress} />
                ) : (
                  <span
                    className={styles.runResult}
                    title={run.status === "failed" ? run.error : undefined}
                  >
                    {/* A failed run's own error is the headline — its result
                        summary only mirrors whatever the plan already said. */}
                    {(run.status === "failed" && run.error) ||
                      describeRunResult(run.resultSummary) ||
                      (run.status === "cancelled" ? "Cancelled before starting" : "No cases settled")}
                  </span>
                )}

                <span className={styles.runMeta}>
                  {run.durationMs != null && (
                    <span>{formatDuration(run.durationMs)}</span>
                  )}
                  <span>{new Date(run.queuedAt).toLocaleString()}</span>
                </span>

                <span className={styles.runRowTail}>
                  {run.status === "running" && (
                    <Tooltip title="Stop this run">
                      <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          stopMutation.mutate(run.runId, {
                            onError: (err) =>
                              message.error(apiErrorMessage(err, "Failed to stop the run")),
                          });
                        }}
                      />
                    </Tooltip>
                  )}
                  {run.status === "queued" && (
                    <Tooltip title="Remove from queue">
                      <Button
                        size="small"
                        icon={<StopOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          cancelMutation.mutate(run.runId, {
                            onError: (err) =>
                              message.error(apiErrorMessage(err, "Failed to cancel the run")),
                          });
                        }}
                      />
                    </Tooltip>
                  )}
                  {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
                </span>
              </button>

              {expanded && (
                <RunActivityPanel
                  sessionId={sessionId}
                  runId={run.runId}
                  onConsent={handleConsent}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RunActivityPanel({ sessionId, runId, onConsent }) {
  const activity = useRunActivity(sessionId, runId, { enabled: true });
  return (
    <div className={styles.runActivityWrap}>
      {activity.live ? (
        <div className={`${styles.runLiveBadge} ${styles.runToneRunning}`}>● live</div>
      ) : (
        <div className={styles.runLiveBadge}>replay</div>
      )}
      <RunActivityStream
        sessionId={sessionId}
        visibleMessages={activity.visibleMessages}
        toolIndex={activity.toolIndex}
        pendingConsent={activity.pendingConsent}
        onConsent={onConsent}
        finished={!activity.live && !!activity.run}
      />
    </div>
  );
}
