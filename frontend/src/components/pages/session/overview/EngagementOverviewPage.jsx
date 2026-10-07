"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Button, Tooltip } from "antd";
import {
  ArrowRightOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { getScans, getTestPlan } from "@/services/websecurity.service";
import { getSessionInfo, getVulnerabilities } from "@/services/agent.service";
import {
  CaseMatrix,
  PageHeader,
  PageShell,
  PageState,
  ProgressRing,
} from "@/components/common/ui";
import ScanLauncherModal from "@/components/pages/session/scans/ScanLauncherModal";
import { ScanStatusPill } from "@/components/pages/session/scans/ScanStatus";
import {
  isScanLive,
  scanName,
  scanProgress,
  scanScopeLabel,
} from "@/utils/scans.mjs";
import { findingsBySeverity } from "@/utils/findings.mjs";
import { scansKey, testPlanKey } from "@/utils/scanQueryKeys.mjs";
import styles from "@/styles/pages/Overview.module.scss";

/**
 * The engagement's home.
 *
 * A session used to land on an empty chat box, which told the operator nothing
 * about the state of the work. This page answers the three questions that
 * matter on arrival: how much of the plan has actually been tested, what has
 * been found, and what is running right now — each with the action that
 * follows from it.
 */

/** The badges under the title: the engagement boundary, in one line. */
function EngagementChips({ target, scope, agentState }) {
  return (
    <>
      {target && (
        <span className={styles.chip}>
          <span className={styles.chipLabel}>Target</span>
          <span className={styles.chipValue} title={target}>
            {target}
          </span>
        </span>
      )}
      {scope && (
        <span className={styles.chip}>
          <span className={styles.chipLabel}>Scope</span>
          <span className={styles.chipValue} title={scope}>
            {scope}
          </span>
        </span>
      )}
      {agentState && (
        <span className={styles.chip}>
          <span className={styles.chipLabel}>Agent</span>
          <span className={styles.chipValue}>{agentState.replace(/_/g, " ")}</span>
        </span>
      )}
    </>
  );
}

/** "6 Oct, 11:36" - compact stamp for a scan row. */
const shortStamp = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function EngagementOverviewPage({ sessionId }) {
  const router = useRouter();
  const [launcherOpen, setLauncherOpen] = useState(false);

  const sessionQuery = useQuery(
    ["session-info", sessionId],
    () => getSessionInfo(sessionId),
    { enabled: !!sessionId, refetchInterval: 10000, retry: false },
  );
  const planQuery = useQuery(
    testPlanKey(sessionId),
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, retry: false },
  );

  const scansQuery = useQuery(scansKey(sessionId), () => getScans(sessionId), {
    enabled: !!sessionId,
    retry: false,
    // One list drives every scan surface; it only has to poll while moving.
    refetchInterval: (data) =>
      (data?.runs ?? []).some(isScanLive) ? 3000 : false,
  });
  const vulnQuery = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
    { enabled: !!sessionId, refetchInterval: 5000, retry: false },
  );

  const session = sessionQuery.data ?? null;
  const plan = planQuery.data?.plan ?? null;
  const coverage = planQuery.data?.coverage ?? null;
  const scans = useMemo(() => scansQuery.data?.runs ?? [], [scansQuery.data]);
  const findings = useMemo(
    () => findingsBySeverity(vulnQuery.data?.vulnerabilities),
    [vulnQuery.data],
  );

  /* The card lists only what a reader must act on first: critical and high.
     The full inventory lives one click away in the findings table. */
  const topFindings = findings.ranked.filter(
    (finding) => ["critical", "high"].includes(String(finding.severity).toLowerCase()),
  );
  const liveScan = scans.find(isScanLive);
  const featuredScan = liveScan ?? scans[0];
  const remaining = coverage ? coverage.notStarted + coverage.inProgress : 0;

  /* The plan's cases, grouped the way the coverage rows are ordered, so the
     grid and the plan page count the categories in the same sequence. */
  const caseRows = useMemo(() => {
    const byCategory = new Map();
    for (const testCase of plan?.cases ?? []) {
      const key = testCase.categoryCode ?? "—";
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push({
        id: testCase.testId,
        status: testCase.status ?? "not_started",
      });
    }
    const order = (coverage?.byCategory ?? []).map((row) => row.key);
    const rank = (key) => {
      const index = order.indexOf(key);
      return index === -1 ? order.length : index;
    };
    return [...byCategory.keys()]
      .sort((a, b) => rank(a) - rank(b))
      .map((key) => ({
        key,
        label: (coverage?.byCategory ?? []).find((row) => row.key === key)?.label ?? key,
        cells: byCategory.get(key),
      }));
  }, [plan, coverage]);

  const header = (
    <PageHeader
      eyebrow="Engagement"
      title={session?.name || "Engagement"}
      /* The chips already name the target and the scope; a sentence repeating
         them is the third place the same fact is written on this screen. */
      description={session?.description || null}
      actions={
        <>
          <Tooltip title="Reload every number on this page">
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                sessionQuery.refetch();
                planQuery.refetch();
                scansQuery.refetch();
                vulnQuery.refetch();
              }}
              aria-label="Reload"
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
            disabled={!plan}
            onClick={() => setLauncherOpen(true)}
          >
            New scan
          </Button>
        </>
      }
      meta={
        <EngagementChips
          target={plan?.target ?? session?.engagement?.target}
          scope={plan?.scope ?? session?.engagement?.scope}
          agentState={session?.agentState}
        />
      }
    />
  );

  const shell = (children) => (
    <PageShell>
      {header}
      {children}
      {launcherOpen && plan && (
        <ScanLauncherModal
          sessionId={sessionId}
          plan={plan}
          onClose={() => setLauncherOpen(false)}
          onLaunched={(run) => {
            setLauncherOpen(false);
            if (run?.runId) router.push(`/session/${sessionId}/scans/${run.runId}`);
          }}
        />
      )}
    </PageShell>
  );

  const fatalError = () => {
    if (planQuery.isError) {
      return {
        title: "Could not load the test plan",
        description:
          "Coverage and scan targets are unknown. Retry before changing anything here.",
      };
    }
    if (scansQuery.isError) {
      return {
        title: "Could not load the scan history",
        description: "The running scan and the progress of earlier ones cannot be shown.",
      };
    }
    if (vulnQuery.isError) {
      return {
        title: "Could not load the findings",
        description: "The engagement's findings cannot be shown.",
      };
    }
    if (sessionQuery.isError) {
      return {
        title: "Could not load this engagement",
        description: "Session details are unavailable.",
      };
    }
    return null;
  };

  // A failed read must never be dressed up as "nothing here yet": on a fresh
  // engagement that is the same screen, but the actions differ.
  if (planQuery.isLoading || scansQuery.isLoading || vulnQuery.isLoading) {
    return shell(<PageState state="loading" rows={4} />);
  }

  const error = fatalError();
  if (error) {
    return shell(
      <PageState
        state="error"
        title={error.title}
        description={error.description}
        onRetry={() => {
          planQuery.refetch();
          scansQuery.refetch();
          vulnQuery.refetch();
          sessionQuery.refetch();
        }}
      />,
    );
  }

  if (!coverage) {
    return shell(
      <PageState
        state="empty"
        title="No test plan yet"
        description="A plan sets the target, the scope and the WSTG cases an engagement covers — scans, findings and the report all come from it."
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

  return shell(
    <>
      <div className={styles.grid}>
        <section className={styles.card}>
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Coverage</h2>
            <Link className={styles.cardLink} href={`/session/${sessionId}/test-plan`}>
              Test plan <ArrowRightOutlined />
            </Link>
          </header>

          <div className={styles.coverageBody}>
            <ProgressRing
              value={coverage.executed}
              total={coverage.total}
              caption="executed"
            />
            <div className={styles.coverageCallout}>
              <span className={styles.calloutNumber}>{remaining}</span>
              <span className={styles.calloutLabel}>cases still need a result</span>
              {remaining > 0 && (
                <button
                  type="button"
                  className={styles.inlineAction}
                  onClick={() => setLauncherOpen(true)}
                >
                  Scan remaining cases <ArrowRightOutlined />
                </button>
              )}
            </div>
          </div>

          <CaseMatrix
            className={styles.coverageMatrix}
            rows={caseRows}
            summary={{
              passed: coverage.passed,
              failed: coverage.failed,
              blocked: coverage.blocked,
              in_progress: coverage.inProgress,
              skipped: coverage.skipped,
              not_started: coverage.notStarted,
            }}
          />
        </section>

        <section className={styles.card}>
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Findings</h2>
            <Link
              className={styles.cardLink}
              href={`/session/${sessionId}/vulnerabilities`}
            >
              All findings <ArrowRightOutlined />
            </Link>
          </header>

          <div className={styles.priorityReadout}>
            <span className={styles.priorityNumber}>{topFindings.length}</span>
            <span>
              critical or high · {findings.total} findings in all
            </span>
          </div>

          {topFindings.length === 0 ? (
            <p className={styles.factMuted}>
              {findings.total > 0
                ? `${findings.total} lower-priority finding${findings.total === 1 ? "" : "s"}; see the full risk breakdown.`
                : "No findings recorded yet. Findings appear when scans or the agent report them."}
            </p>
          ) : (
            <ul className={styles.findingList}>
              {topFindings.slice(0, 3).map((finding) => (
                <li key={finding.vulnerabilityId} className={styles.findingItem}>
                  <span
                    className={`${styles.severityDot} ${styles[`dot_${String(finding.severity).toLowerCase()}`] ?? ""}`}
                  />
                  <Link
                    className={styles.findingLink}
                    href={`/session/${sessionId}/vulnerabilities/${finding.vulnerabilityId}`}
                  >
                    {finding.title || finding.vulnerabilityId}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Scans</h2>
          <Link className={styles.cardLink} href={`/session/${sessionId}/scans`}>
            Scan history <ArrowRightOutlined />
          </Link>
        </header>

        {!featuredScan ? (
          <p className={styles.factMuted}>
            No scans yet. Launch one to start testing {plan?.target || "the target"}.
          </p>
        ) : (
          <div className={styles.scanFeature}>
            <div className={styles.scanFeatureMain}>
              <span className={styles.scanFeatureLabel}>
                {featuredScan.status === "queued"
                  ? "Waiting in queue"
                  : liveScan ? "Running now" : "Most recent run"}
              </span>
              <Link
                className={styles.scanName}
                href={`/session/${sessionId}/scans/${featuredScan.runId}`}
              >
                {scanName(featuredScan, plan?.cases ?? [])}
              </Link>
              <span className={styles.scanMeta}>
                {scanScopeLabel(featuredScan, plan?.cases ?? [])}
                {featuredScan.startedAt ? ` · ${shortStamp(featuredScan.startedAt)}` : ""}
              </span>
            </div>
            <ScanStatusPill status={featuredScan.status} />
            {featuredScan.status === "running" && (
              <span className={styles.scanProgress}>
                {scanProgress(featuredScan.testIds, plan?.cases ?? [], {
                  since: featuredScan.startedAt,
                }).percent}% tested
              </span>
            )}
            <Link
              className={styles.scanOpen}
              href={`/session/${sessionId}/scans/${featuredScan.runId}`}
            >
              {featuredScan.status === "running" ? "Watch run" : "View run"} <ArrowRightOutlined />
            </Link>
          </div>
        )}
      </section>
    </>,
  );
}
