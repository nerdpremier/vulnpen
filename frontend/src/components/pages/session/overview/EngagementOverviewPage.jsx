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
import {
  FiActivity,
  FiAlertTriangle,
  FiCheckCircle,
  FiClock,
} from "react-icons/fi";
import { getScans, getTestPlan } from "@/services/websecurity.service";
import { getSessionInfo, getVulnerabilities } from "@/services/agent.service";
import {
  BarList,
  CaseMatrix,
  PageHeader,
  PageShell,
  PageState,
  ProgressRing,
  RadarChart,
  SeverityBar,
  StatStrip,
  StatTile,
  TimelineChart,
} from "@/components/common/ui";
import ScanLauncherModal from "@/components/pages/session/scans/ScanLauncherModal";
import { ScanStatusPill } from "@/components/pages/session/scans/ScanStatus";
import { isScanLive, scanActivity, scanName, scanProgress, scanScopeLabel, scanTimeline } from "@/utils/scans.mjs";
import { findingsBySeverity } from "@/utils/findings.mjs";
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

/** Days of scan history drawn as the spark on the Scans tile. */
const SPARK_DAYS = 14;
/** Runs drawn on the activity timeline - the recent shape, not the archive. */
const TIMELINE_RUNS = 8;

/** "12 Mar, 14:05" - short enough to sit under a chart as an axis caption. */
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
    ["test-plan", sessionId],
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, retry: false },
  );

  const scansQuery = useQuery(["scans", sessionId], () => getScans(sessionId), {
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

  const liveScan = scans.find(isScanLive) ?? null;
  const latestScan = liveScan ?? scans[0] ?? null;
  const topFindings = findings.ranked.slice(0, 5);

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

  /* The same ten chapters the plan orders by, on one shape: the outline is the
     answer to "where is this engagement thin?", which ten separate rows ask the
     reader to reconstruct.
     The axis label is the four-letter chapter code, not the full name: ten
     "Information Gathering"-length labels do not fit around a 244px dial, and
     the case grid below carries the same codes. */
  const coverageAxes = useMemo(
    () =>
      (coverage?.byCategory ?? []).map((row) => ({
        key: row.key,
        label: row.key,
        value: row.executed,
        max: row.total,
      })),
    [coverage],
  );

  /* Findings per host: the map of where this target is actually hurt. */
  const hostBars = useMemo(() => {
    const counts = new Map();
    for (const finding of findings.ranked) {
      const host = finding.host || finding.endpoint || "unattributed";
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([host, value]) => ({ key: host, label: host, value, tone: "accent" }));
  }, [findings]);

  /* Scans per day for the last fortnight - a trend line needs no sentence. */
  const scanSpark = useMemo(
    () => scanActivity(scans, { days: SPARK_DAYS }),
    [scans],
  );

  /* When the recent runs happened and how long each took: gaps, duration and
     which run died are all readable without opening a single scan. */
  const timeline = useMemo(
    () => scanTimeline(scans, { limit: TIMELINE_RUNS, planCases: plan?.cases ?? [] }),
    [scans, plan],
  );
  const scanTimelineRows = timeline.rows;

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

  const remaining = coverage.notStarted + coverage.inProgress;
  // The tile says which severity actually leads the engagement, not just
  // whether anything reached critical.
  const leadingLevel = findings.levels.find((level) => level.count > 0) ?? null;

  return shell(
    <>
      <StatStrip className={styles.strip}>
        <StatTile
          label="Cases executed"
          icon={<FiCheckCircle />}
          value={coverage.executed}
          total={coverage.total}
          /* No "% of the plan" hint: the coverage dial two lines below prints
             exactly that percentage. */
        />
        <StatTile
          label="Findings"
          icon={<FiAlertTriangle />}
          value={findings.total}
          tone={findings.levels[0]?.count ? "danger" : "neutral"}
          hint={
            leadingLevel
              ? `${leadingLevel.count} ${leadingLevel.label.toLowerCase()}`
              : "nothing recorded"
          }
        />
        <StatTile
          label="Scans"
          icon={<FiActivity />}
          value={scans.length}
          spark={scans.length ? scanSpark : undefined}
          hint={liveScan ? "one running now" : "last 14 days"}
        />
        <StatTile
          label="Not executed"
          icon={<FiClock />}
          value={remaining}
          total={coverage.total}
          tone={remaining > 0 ? "warning" : "success"}
          hint={remaining > 0 ? "work left in the plan" : "plan fully settled"}
        />
      </StatStrip>

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
              caption="CASES"
              showPercent
            />
            {/* The plan's ten WSTG chapters as one outline, then one square per
                case below it: the shape says where the engagement is thin, the
                squares say which cases are missing. */}
            <RadarChart
              axes={coverageAxes}
              size={244}
              label="Cases executed per WSTG category"
            />
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

          <SeverityBar levels={findings.levels} />

          {/* Where the findings actually are. The severity bar says how bad;
              this says where to look first. */}
          {hostBars.length > 1 && (
            <div className={styles.hostBars}>
              <span className={styles.subLabel}>By host</span>
              <BarList items={hostBars} />
            </div>
          )}

          {topFindings.length === 0 ? (
            <p className={styles.factMuted}>
              Nothing recorded yet. Findings land here as scans and the agent
              report them.
            </p>
          ) : (
            <ul className={styles.findingList}>
              {topFindings.map((finding) => (
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

      {/* The scan of the moment gets the whole width: squeezed into half a page
          its status, identity, progress and action crowded each other. */}
      <section className={styles.card}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {liveScan ? "Running now" : "Latest scan"}
          </h2>
          <Link className={styles.cardLink} href={`/session/${sessionId}/scans`}>
            Scan history <ArrowRightOutlined />
          </Link>
        </header>

        {!latestScan ? (
          <p className={styles.factMuted}>
            Never scanned. A scan runs the cases you pick against{" "}
            {plan?.target || "the target"} without further input.
          </p>
        ) : (
          <div className={styles.scanRow}>
            <ScanStatusPill status={latestScan.status} />
            <span className={styles.scanIdentity}>
              <Link
                className={styles.scanName}
                href={`/session/${sessionId}/scans/${latestScan.runId}`}
              >
                {scanName(latestScan, plan?.cases ?? [])}
              </Link>
              <span className={styles.scanMeta}>
                {scanScopeLabel(latestScan, plan?.cases ?? [])}
                {latestScan.startedAt
                  ? ` · started ${new Date(latestScan.startedAt).toLocaleString()}`
                  : ""}
              </span>
            </span>
            {isScanLive(latestScan) && (
              <span className={styles.scanProgress}>
                {scanProgress(
                  latestScan.testIds,
                  plan?.cases ?? [],
                  { since: latestScan.startedAt },
                ).percent}
                %
              </span>
            )}
            <Link
              className={styles.scanOpen}
              href={`/session/${sessionId}/scans/${latestScan.runId}`}
            >
              {isScanLive(latestScan) ? "Watch" : "Open"} <ArrowRightOutlined />
            </Link>
          </div>
        )}

        {remaining > 0 && (
          <p className={styles.nextStep}>
            <strong>{remaining}</strong> case{remaining === 1 ? "" : "s"} still
            need a result.{" "}
            <button
              type="button"
              className={styles.inlineAction}
              onClick={() => setLauncherOpen(true)}
            >
              Scan them
            </button>
          </p>
        )}

        {/* The recent runs on one axis: gaps, duration and which one died are
            all visible without opening a single scan. */}
        {scanTimelineRows.length > 1 && (
          <div className={styles.activity}>
            <span className={styles.subLabel}>Recent runs</span>
            <TimelineChart
              items={scanTimelineRows}
              startLabel={timeline.start ? shortStamp(timeline.start) : undefined}
              endLabel={timeline.end ? shortStamp(timeline.end) : undefined}
            />
          </div>
        )}
      </section>
    </>,
  );
}
