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
import { PageShell, PageState } from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
import ScanLauncherModal from "@/components/pages/session/scans/ScanLauncherModal";
import AttackSurface from "./AttackSurface";
import { ScanStatusPill } from "@/components/pages/session/scans/ScanStatus";
import { isScanLive } from "@/utils/scans.mjs";
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

/** "6 Oct, 11:36" - compact stamp for a scan row. */
/* The chapter cards are narrow, so a long WSTG chapter name is cut mid-word.
   Dropping the trailing "Testing" keeps every chapter's meaningful words and
   reads whole: "Configuration and Deployment Management". */
const shortChapterLabel = (label) =>
  String(label ?? "").replace(/\s+Testing$/, "").trim();

/* A case is settled once it produced a result. `skipped` is deliberately left
   out: it is a gap the operator chose, and the dial has to show it as one. */
const settledCount = (counts) =>
  (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.blocked ?? 0);

/**
 * The coverage dial: every chapter as one arc of one ring, the executed share
 * filled and the skipped share left dark. A chapter is lit while hovered or
 * focused, and the ring's centre reads that chapter's own numbers — so the
 * whole plan is one shape and every part of it stays reachable without a list.
 */
function CoverageDial({ rows, activeKey, onActivate }) {
  const SIZE = 260;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  /* A thin ring leaves a wide hole for the readout, and the hole is where the
     number lives — the ring only has to be legible, not heavy. */
  const R = 101;
  const STROKE = 11;
  const GAP_DEG = 2.6;

  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const settled = rows.reduce((sum, row) => sum + settledCount(row.counts), 0);

  const active = rows.find((row) => row.key === activeKey) ?? null;

  let cursor = -90;
  const arcs = rows.map((row) => {
    const span = total > 0 ? (row.total / total) * 360 : 0;
    const start = cursor;
    cursor += span;
    const end = cursor - GAP_DEG;
    const executed = settledCount(row.counts);
    const passShare = row.total > 0 ? (row.counts.passed ?? 0) / row.total : 0;
    const failShare = row.total > 0
      ? ((row.counts.failed ?? 0) + (row.counts.blocked ?? 0)) / row.total
      : 0;
    return {
      row,
      start,
      end,
      executed,
      /* The fill runs to the executed share; the tail of it is red when that
         work went badly. A chapter that ran everything and failed everything
         therefore reads as a full red arc, not as a finished green one. */
      runEnd: start + (end - start) * (passShare + failShare),
      passEnd: start + (end - start) * passShare,
    };
  });

  const polar = (deg, radius) => {
    const rad = (deg * Math.PI) / 180;
    return [CX + Math.cos(rad) * radius, CY + Math.sin(rad) * radius];
  };
  const arcPath = (start, end, radius) => {
    const [x1, y1] = polar(start, radius);
    const [x2, y2] = polar(end, radius);
    const large = end - start > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
  };
  const seg = (start, end) =>
    end - start > 0.4 ? arcPath(start, end, R) : null;

  const activeSettled = active ? settledCount(active.counts) : settled;
  const activeTotal = active ? active.total : total;
  const activeFailed = active
    ? (active.counts.failed ?? 0) + (active.counts.blocked ?? 0)
    : rows.reduce((sum, row) => sum + (row.counts.failed ?? 0) + (row.counts.blocked ?? 0), 0);
  const shown = {
    label: active ? active.label : "",
    count: activeSettled,
    total: activeTotal,
    failed: activeFailed,
    percent: activeTotal > 0 ? Math.round((activeSettled / activeTotal) * 100) : 0,
  };

  return (
    <div className={styles.dial}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={styles.dialSvg}
        role="img"
        aria-label={`Test plan coverage: ${settled} of ${total} cases executed across ${rows.length} chapters`}
      >
        {arcs.map(({ row, start, end, runEnd, passEnd }) => {
          const lit = activeKey === row.key;
          const pass = seg(start, passEnd);
          const fail = seg(passEnd, runEnd);
          return (
            <g
              key={row.key}
              className={`${styles.dialArc} ${lit ? styles.dialArcLit : ""} ${
                activeKey && !lit ? styles.dialArcDim : ""
              }`}
              onMouseEnter={() => onActivate(row.key)}
              onMouseLeave={() => onActivate(null)}
            >
              <path
                d={arcPath(start, end, R)}
                className={styles.dialTrack}
                strokeWidth={STROKE}
                fill="none"
              />
              {pass && (
                <path
                  d={pass}
                  className={styles.dialPass}
                  strokeWidth={STROKE}
                  fill="none"
                />
              )}
              {fail && (
                <path
                  d={fail}
                  className={styles.dialFail}
                  strokeWidth={STROKE}
                  fill="none"
                />
              )}
            </g>
          );
        })}
      </svg>

      <div className={styles.dialReadout} aria-hidden="true">
        <span className={styles.dialPercent}>
          {shown.percent}
          <span className={styles.dialPercentMark}>%</span>
        </span>
        {/* Unpicked, the hero already states the plan's 79/97, so the ring leads
            with the one figure it owns — the executed share. Picking a chapter
            adds that chapter's name and its own count, which are new. */}
        {shown.label && (
          <>
            <span className={styles.dialLabel}>{shown.label}</span>
            <span className={styles.dialCount}>
              {shown.count}
              <span>/{shown.total}</span>
            </span>
          </>
        )}
        {shown.failed > 0 && (
          <span className={styles.dialFailed}>
            {shown.failed} failed or blocked
          </span>
        )}
      </div>
    </div>
  );
}

export default function EngagementOverviewPage({ sessionId }) {
  const router = useRouter();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [activeChapter, setActiveChapter] = useState(null);

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
  const criticalHigh = findings.levels
    .filter((level) => ["critical", "high"].includes(level.key))
    .reduce((sum, level) => sum + level.count, 0);
  /* The severities that actually occur, in canonical order. The findings bar
     and its key are built from this one list, so segment order, colour and
     label can never drift apart. */
  const populatedLevels = findings.levels.filter((level) => level.count > 0);

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
      .map((key) => {
        const cells = byCategory.get(key);
        /* A readable bar needs counts, not 19 anonymous squares: count each
           status once here so the row renders as one labelled shape. */
        const counts = { passed: 0, failed: 0, blocked: 0, in_progress: 0, skipped: 0, not_started: 0 };
        for (const cell of cells) counts[cell.status] = (counts[cell.status] ?? 0) + 1;
        const label =
          (coverage?.byCategory ?? []).find((row) => row.key === key)?.label ?? key;
        return {
          key,
          /* "Configuration and Deployment Management Testing" truncates to
             "Configuration and Deployment Man…" in a card; the first two words
             name the chapter well enough and stay whole. */
          label: shortChapterLabel(label),
          counts,
          total: cells.length,
        };
      });
  }, [plan, coverage]);

  /* The page's actions ride in the app header, beside the engagement's
     breadcrumb — the body opens directly on the graph instead of on a band of
     buttons. Published rather than rendered here because the header belongs to
     the session layout, a level above this page. */
  const actions = useMemo(
    () => (
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
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, plan, router],
  );

  usePublishHeaderActions(actions);

  const shell = (children) => (
    <PageShell>
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
      {/* The hero: the engagement as a sphere of chapters, each node a chapter
          coloured by outcome. The figures ride beside it, so the same data is
          read two ways — shape first, then number. */}
      <section className={styles.hero} aria-label="Engagement at a glance">
        <div className={styles.heroStage}>
          <AttackSurface
            findings={findings.ranked}
            sessionId={sessionId}
            className={styles.heroCanvas}
          />
          <div className={styles.heroLegend} aria-hidden="true">
            {findings.levels
              .filter((level) => level.count > 0)
              .map((level) => (
                <span key={level.key}>
                  <i className={`${styles.legendDot} ${styles[`legend_${level.key}`]}`} />
                  {level.label.toLowerCase()}
                </span>
              ))}
          </div>
        </div>

        <div className={styles.heroFacts}>
          {/* A status ledger, read top to bottom: the agent's live state, then
              each measure of the engagement as one row — a state dot, the
              label, the value, and the bar that is the value drawn to scale.
              Nothing sits alone in half a box and no figure is stated twice. */}
          <div className={`${styles.ledgerRow} ${styles.ledgerHead}`}>
            <span className={styles.ledgerDot} data-live={liveScan ? "yes" : "no"} aria-hidden="true" />
            <span className={styles.ledgerLabel}>Agent</span>
            <span className={styles.ledgerValue}>
              {(session?.agentState ?? "idle").replace(/_/g, " ")}
            </span>
          </div>

          <Link
            className={styles.ledgerRow}
            href={`/session/${sessionId}/test-plan`}
          >
            <span className={styles.ledgerLabel}>Cases executed</span>
            <span className={styles.ledgerValue}>
              <b>{coverage.executed}</b>
              <span>/{coverage.total}</span>
            </span>
            <span className={styles.ledgerBar}>
              <span className={styles.ledgerTrack} aria-hidden="true">
                <span
                  className={styles.ledgerFill}
                  style={{
                    width: `${
                      coverage.total > 0
                        ? Math.round((coverage.executed / coverage.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </span>
              <span className={styles.ledgerScale}>
                <span>executed</span>
                <span>{remaining} left</span>
              </span>
            </span>
          </Link>

          <Link
            className={styles.ledgerRow}
            href={`/session/${sessionId}/vulnerabilities`}
          >
            <span className={styles.ledgerLabel}>Findings</span>
            <span className={styles.ledgerValue}>
              <b>{findings.total}</b>
            </span>
            <span className={styles.ledgerBar}>
              <span
                className={`${styles.ledgerTrack} ${styles.ledgerTrackSplit}`}
                aria-hidden="true"
              >
                {populatedLevels.map((level) => (
                  <span
                    key={level.key}
                    className={`${styles.ledgerSeg} ${styles[`ledger_${level.key}`]}`}
                    style={{ flexGrow: level.count }}
                  />
                ))}
              </span>
              {/* Each segment named and counted, so a colour is never guessed:
                  the bar's own key, read left to right in the bar's own order. */}
              <span className={styles.ledgerScale}>
                {populatedLevels.map((level) => (
                  <span key={level.key} className={styles.ledgerScaleItem}>
                    <i
                      className={`${styles.ledgerChip} ${styles[`ledger_${level.key}`]}`}
                      aria-hidden="true"
                    />
                    {level.label.toLowerCase()} {level.count}
                  </span>
                ))}
              </span>
            </span>
          </Link>

          <Link
            className={styles.ledgerRow}
            href={`/session/${sessionId}/vulnerabilities`}
            data-empty={criticalHigh > 0 ? "no" : "yes"}
          >
            <span className={styles.ledgerLabel}>Critical / high</span>
            <span className={styles.ledgerValue}>
              <b>{criticalHigh}</b>
              <span>/{findings.total}</span>
            </span>
            <span className={styles.ledgerBar}>
              <span className={styles.ledgerTrack} aria-hidden="true">
                <span
                  className={`${styles.ledgerFill} ${styles.ledgerFillDanger}`}
                  style={{
                    width: `${
                      findings.total > 0
                        ? Math.round((criticalHigh / findings.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </span>
              <span className={styles.ledgerScale}>
                <span>of all findings</span>
              </span>
            </span>
          </Link>

          <div className={styles.ledgerFoot}>
            <ScanStatusPill status={featuredScan?.status ?? "idle"} />
            {featuredScan ? (
              <Link
                className={styles.heroScanLink}
                href={`/session/${sessionId}/scans/${featuredScan.runId}`}
              >
                {liveScan ? "watch run" : "last run"} →
              </Link>
            ) : (
              <button
                type="button"
                className={styles.heroScanLink}
                onClick={() => setLauncherOpen(true)}
                disabled={!plan}
              >
                start a scan →
              </button>
            )}
          </div>
        </div>
      </section>

      <div className={styles.columns}>
        {/* Left: the findings that change decisions, worst first. */}
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>
              <span className={styles.panelMark} aria-hidden="true" />
              Needs attention
            </h2>
            <Link
              className={styles.panelLink}
              href={`/session/${sessionId}/vulnerabilities`}
            >
              {/* The hero already states the total. Here the useful fact is how
                  many the card is not showing, so the number never repeats. */}
              {findings.total > topFindings.length
                ? `+${findings.total - Math.min(topFindings.length, 7)} more →`
                : "open all →"}
            </Link>
          </div>

          {topFindings.length === 0 ? (
            <p className={styles.panelEmpty}>
              {findings.total > 0
                ? "Nothing at critical or high — the full table has the rest."
                : "Nothing reported yet. Findings appear when scans or the agent report them."}
            </p>
          ) : (
            <ul className={styles.board}>
              {topFindings.slice(0, 7).map((finding, index) => {
                const sev = String(finding.severity).toLowerCase();
                const endpoint =
                  finding.endpoint || finding.service || finding.host;
                return (
                  <li key={finding.vulnerabilityId} className={styles.boardItem}>
                    <Link
                      className={`${styles.boardCard} ${styles[`board_${sev}`] ?? ""}`}
                      href={`/session/${sessionId}/vulnerabilities/${finding.vulnerabilityId}`}
                    >
                      <span className={styles.boardRank} aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className={styles.boardBody}>
                        <span className={styles.boardTitle}>
                          {finding.title || finding.vulnerabilityId}
                        </span>
                        {endpoint && (
                          <span className={styles.boardEndpoint}>{endpoint}</span>
                        )}
                      </span>
                      <span className={styles.boardSev}>{sev}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Right: the whole plan as one dial, then the chapters as a legend that
            drives it — the ring states the total, the legend names the parts. */}
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>
              <span className={styles.panelMark} aria-hidden="true" />
              Coverage
            </h2>
            {remaining > 0 ? (
              <button
                type="button"
                className={styles.panelLink}
                onClick={() => setLauncherOpen(true)}
              >
                scan remaining →
              </button>
            ) : (
              <Link
                className={styles.panelLink}
                href={`/session/${sessionId}/test-plan`}
              >
                test plan →
              </Link>
            )}
          </div>

          <div className={styles.coverBody}>
            <CoverageDial
              rows={caseRows}
              activeKey={activeChapter}
              onActivate={setActiveChapter}
            />

            <ul className={styles.legend}>
              {caseRows.map((row) => {
                const settled = settledCount(row.counts);
                const lit = activeChapter === row.key;
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      className={`${styles.legendRow} ${lit ? styles.legendRowLit : ""}`}
                      onMouseEnter={() => setActiveChapter(row.key)}
                      onMouseLeave={() => setActiveChapter(null)}
                      onFocus={() => setActiveChapter(row.key)}
                      onBlur={() => setActiveChapter(null)}
                      onClick={() => router.push(`/session/${sessionId}/test-plan`)}
                      title={`${row.label} — ${settled}/${row.total} executed, ${row.counts.failed ?? 0} failed, ${row.counts.skipped ?? 0} skipped`}
                    >
                      <span
                        className={`${styles.legendKey} ${
                          (row.counts.failed ?? 0) > 0 ? styles.legendKeyAlert : ""
                        }`}
                        aria-hidden="true"
                      />
                      <span className={styles.legendName}>{row.label}</span>
                      <span className={styles.legendCount}>
                        <b>{settled}</b>
                        <span>/{row.total}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </div>
    </>,
  );
}
