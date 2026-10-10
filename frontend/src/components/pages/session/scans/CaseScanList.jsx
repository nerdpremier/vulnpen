"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { RightOutlined } from "@ant-design/icons";
import { getScans } from "@/services/websecurity.service";
import { PageState } from "@/components/common/ui";
import {
  countScanCases,
  formatDuration,
  formatStamp,
  isScanLive,
  scanCaseStatuses,
  scanName,
} from "@/utils/scans.mjs";
import { ScanProgressBar, ScanStatusPill } from "./ScanStatus";
import { caseScansKey } from "@/utils/scanQueryKeys.mjs";
import styles from "@/styles/pages/TestPlan.module.scss";
import detail from "@/styles/pages/ScanDetail.module.scss";

/**
 * The scans that touched one case, newest first — the case page's own slice of
 * the scan history. Only this case's scans belong here: the session-wide list
 * lives on the Scans page.
 *
 * The key itself lives in the shared scan-keys module, so an invalidation
 * written elsewhere (a scan mutation) reaches this poll too.
 */
export const caseScansQueryKey = caseScansKey;

/**
 * A settled scan's outcome as a strip rather than a sentence: how it ended is
 * the colour split, how far it got is the number underneath.
 */
function OutcomeStrip({ counts }) {
  const segments = [
    { key: "passed", value: counts.passed, tone: detail.segPassed },
    { key: "failed", value: counts.failed, tone: detail.segFailed },
    { key: "blocked", value: counts.blocked, tone: detail.segBlocked },
    { key: "skipped", value: counts.skipped, tone: detail.segSkipped },
    { key: "not_executed", value: counts.notExecuted, tone: detail.segIdle },
  ].filter((segment) => segment.value > 0);

  return (
    <span className={detail.outcome}>
      <span
        className={detail.outcomeBar}
        role="img"
        aria-label={`${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.notExecuted} without a result`}
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={`${detail.stripSeg} ${segment.tone}`}
            style={{ flexGrow: segment.value }}
          />
        ))}
      </span>
      <span className={styles.caseScanSettled}>
        <strong>{counts.total - counts.notExecuted}</strong>/{counts.total} settled
      </span>
    </span>
  );
}

export default function CaseScanList({ sessionId, testCase, planCases }) {
  const router = useRouter();
  // The case page normalises the URL's id the same way, so both consumers share
  // one query key (and one poll) whatever the URL's casing.
  const caseId = testCase.testId.trim().toUpperCase();
  const scansQuery = useQuery(
    caseScansQueryKey(sessionId, caseId),
    () => getScans(sessionId, { testId: caseId }),
    {
      refetchInterval: (data) => ((data?.runs ?? []).some(isScanLive) ? 2000 : false),
    },
  );

  const scans = scansQuery.data?.runs ?? [];
  const running = scans.find(isScanLive) ?? null;

  if (scansQuery.isLoading) {
    return (
      <section className={`${styles.caseScans} ${styles.caseScansPad}`}>
        <PageState state="loading" rows={2} />
      </section>
    );
  }

  return (
    <section className={styles.caseScans}>
      <div className={styles.caseScansHead}>
        <h2 className={styles.caseScansTitle}>Scan history</h2>
        <span className={styles.runsCount}>{scans.length}</span>
        {running && (
          <button
            type="button"
            className={styles.caseScansLive}
            onClick={() => router.push(`/session/${sessionId}/scans/${running.runId}`)}
          >
            {running.status === "queued" ? "queued" : "running now"} — watch it
          </button>
        )}
        <Link href={`/session/${sessionId}/scans`} className={styles.caseScansAll}>
          All scans
        </Link>
      </div>

      {scansQuery.isError ? (
        <p className={styles.caseScansEmpty}>Could not load this case&apos;s scans.</p>
      ) : !scans.length ? (
        <p className={styles.caseScansEmpty}>
          This case has never been scanned. The Scan button records its result
          here and on the plan.
        </p>
      ) : (
        <div className={styles.caseScanList}>
          {scans.map((scan) => {
            const counts = countScanCases(scanCaseStatuses(scan, planCases));
            return (
              <Link
                key={scan.runId}
                href={`/session/${sessionId}/scans/${scan.runId}`}
                className={styles.caseScanRow}
              >
                <ScanStatusPill status={scan.status} />
                <span className={styles.scanIdentity}>
                  <span className={styles.scanName}>{scanName(scan, planCases)}</span>
                  <span className={styles.scanMeta}>
                    {formatStamp(scan.startedAt ?? scan.queuedAt)}
                    {scan.durationMs != null ? ` · ${formatDuration(scan.durationMs)}` : ""}
                  </span>
                </span>
                <span className={styles.caseScanOutcome}>
                  {isScanLive(scan) ? (
                    <ScanProgressBar
                      testIds={scan.testIds}
                      planCases={planCases}
                      since={scan.startedAt}
                    />
                  ) : (
                    <OutcomeStrip counts={counts} />
                  )}
                </span>
                <RightOutlined className={styles.caseScanChevron} />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
