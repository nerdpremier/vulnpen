"use client";

import React from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  MinusCircleFilled,
  PauseCircleFilled,
  PlayCircleFilled,
} from "@ant-design/icons";
import styles from "@/styles/pages/TestPlan.module.scss";
import { scanProgress } from "@/utils/scans.mjs";

/** The scan lifecycle, rendered the same way in the list and on the detail page. */

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

/** Exported so a surface that draws the state as a dot and a word, rather than
 *  as a pill, still uses the same five words. */
export const SCAN_STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function ScanStatusPill({ status }) {
  return (
    <span className={`${styles.runStatusPill} ${STATUS_TONE[status] ?? ""}`}>
      {STATUS_ICON[status]} {SCAN_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function ScanProgressBar({ testIds, planCases, since }) {
  const progress = scanProgress(testIds, planCases, { since });
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
