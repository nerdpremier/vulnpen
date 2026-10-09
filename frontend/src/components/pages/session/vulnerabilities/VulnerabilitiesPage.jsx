"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Button, Input, Select, Tooltip } from "antd";
import {
  MessageOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import Link from "next/link";
import { FiAlertTriangle } from "react-icons/fi";
import { getVulnerabilities } from "@/services/agent.service";
import styles from "@/styles/pages/Vulnerabilities.module.scss";
import {
  AnimatedContent,
  ColumnChart,
  EmptyState,
  PageShell,
  PageState,
} from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
import {
  compareBySeverity,
  findingsBySeverity,
} from "@/utils/findings.mjs";

/** CVSS v3.0 base-score bands, the same cut points the severity ramp uses.
    The axis reads the full band name; the numeric span lives in the tooltip. */
const CVSS_BANDS = [
  { key: "none", axis: "0.0", label: "0.0 (None)", tone: "mute", min: 0, max: 0.1 },
  { key: "low", axis: "low", label: "0.1–3.9", tone: "low", min: 0.1, max: 4 },
  { key: "medium", axis: "medium", label: "4.0–6.9", tone: "medium", min: 4, max: 7 },
  { key: "high", axis: "high", label: "7.0–8.9", tone: "high", min: 7, max: 9 },
  { key: "critical", axis: "critical", label: "9.0–10", tone: "critical", min: 9, max: 10.1 },
];

/** The severity ramp, the one vocabulary every surface shares. */
const SEVERITY_TONE = {
  critical: "#ff4d5e",
  high: "#ff8a3d",
  medium: "#ffd166",
  low: "#7fb2ff",
  info: "#79d1ff",
};

/** The score the system computed, or null when the finding carries none. */
function cvssScoreOf(item) {
  const score = item?.cvss?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

function SeverityBadge({ severity }) {
  const value = severity || "info";
  return <span className={`${styles.severity} ${styles[value]}`}>{value}</span>;
}

export default function VulnerabilitiesPage({ sessionId }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const [owaspFilter, setOwaspFilter] = useState("all");
  const { data, isLoading, isError, refetch } = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
    { refetchInterval: 5000 },
  );

  const vulnerabilities = useMemo(
    () => data?.vulnerabilities ?? [],
    [data?.vulnerabilities],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return vulnerabilities
      .filter((item) => severity === "all" || item.severity === severity)
      .filter((item) => {
        if (owaspFilter === "all") return true;
        return item.owaspTop10 === owaspFilter;
      })
      .filter((item) => {
        if (!needle) return true;
        return [
          item.title,
          item.host,
          item.service,
          item.endpoint,
          item.cwe,
          item.cve,
          item.owaspTop10,
          item.owaspTop10Title,
          item.wstgId,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        // One severity ordering for the whole product (`utils/findings.mjs`).
        const delta = compareBySeverity(a, b);
        return (
          delta ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
  }, [vulnerabilities, search, severity, owaspFilter]);

  /* ---- The numbers the summary stands for, each stated once ---------------- */
  const severityLevels = useMemo(
    () => findingsBySeverity(vulnerabilities).levels,
    [vulnerabilities],
  );
  const exploitedCount = vulnerabilities.filter((item) => item.exploited).length;
  const unverifiedCount = vulnerabilities.length - exploitedCount;

  /* Scored findings per band only. Unrated findings stay off the chart — they
     carry no score to bin, and one grey "none" tower dwarfed real bands. */
  const scoreBands = useMemo(() => {
    const scored = vulnerabilities.filter((item) => cvssScoreOf(item) != null);
    const bands = CVSS_BANDS.map((band) => {
      const value = scored.filter((item) => {
        const score = cvssScoreOf(item);
        return score >= band.min && score < band.max;
      }).length;
      return {
        key: band.key,
        label: band.axis,
        tone: band.tone,
        value,
        title: `CVSS ${band.label}: ${value} finding${value === 1 ? "" : "s"}`,
      };
    });
    return bands;
  }, [vulnerabilities]);

  const unratedCount = vulnerabilities.filter((item) => cvssScoreOf(item) == null).length;

  const owaspOptions = useMemo(() => {
    const seen = new Map();
    for (const item of vulnerabilities) {
      if (item.owaspTop10) {
        seen.set(item.owaspTop10, item.owaspTop10Title || "");
      }
    }
    return [
      { value: "all", label: "All OWASP Top 10:2025" },
      ...Array.from(seen.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, label]) => ({ value, label: `${value} ${label}`.trim() })),
    ];
  }, [vulnerabilities]);

  const hasFilters =
    Boolean(search.trim()) || severity !== "all" || owaspFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setSeverity("all");
    setOwaspFilter("all");
  };

  const openFinding = (item) =>
    router.push(`/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`);

  const actions = useMemo(
    () => (
      <>
        <Tooltip title="Reload the findings">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => refetch()}
            aria-label="Reload the findings"
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
          icon={<SearchOutlined />}
          onClick={() => {
            const node = document.querySelector(`.${styles.search} input`);
            node?.focus();
          }}
          disabled={!vulnerabilities.length}
        >
          Search findings
        </Button>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, router, vulnerabilities.length],
  );
  usePublishHeaderActions(actions);

  if (isLoading) {
    return (
      <PageShell>
        <PageState state="loading" rows={6} />
      </PageShell>
    );
  }

  if (isError) {
    return (
      <PageShell>
        <PageState
          state="error"
          title="Could not load the findings"
          description="The findings could not be read. The page keeps polling; retry to see them now."
          onRetry={() => refetch()}
        />
      </PageShell>
    );
  }

  if (!vulnerabilities.length) {
    return (
      <PageShell>
        <header className={styles.pageHead}>
          <span className={styles.eyebrow}>Engagement</span>
          <h1>Vulnerabilities</h1>
        </header>
        <EmptyState
          icon={<FiAlertTriangle />}
          title="No vulnerabilities recorded yet"
          description="Findings appear here once a scan proves one out on the target."
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header className={styles.pageHead}>
        <span className={styles.eyebrow}>Engagement</span>
        <h1>Vulnerabilities</h1>
      </header>

      {/* The summary band. The CVSS distribution is the anchcard — the one
          graphic a tester reads first — so it keeps the widest column and the
          column chart it has always had; the severity mix and the exploitation
          proof sit beside it as their own shapes. */}
      <section className={styles.summaryBand} aria-label="Finding overview">
        <div className={styles.summaryCell}>
          <div className={styles.summaryCard}>
            <h2 className={styles.summaryTitle}>
              Severity mix
              <span className={styles.titleCount}>{vulnerabilities.length}</span>
            </h2>
            <div className={styles.ridge}>
              {severityLevels.map((level) => (
                <button
                  key={level.key}
                  type="button"
                  className={styles.ridgeRow}
                  data-active={severity === level.key || undefined}
                  onClick={() =>
                    setSeverity(severity === level.key ? "all" : level.key)
                  }
                >
                  <span className={styles.ridgeLabel}>{level.label}</span>
                  <span className={styles.ridgeTrack}>
                    <span
                      className={styles.ridgeBar}
                      style={{
                        width: `${
                          (level.count /
                            Math.max(1, ...severityLevels.map((l) => l.count))) *
                          100
                        }%`,
                        background: SEVERITY_TONE[level.key],
                      }}
                    />
                  </span>
                  <span className={styles.ridgeCount}>{level.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.summaryCell}>
          <div className={styles.summaryCard}>
            <h2 className={styles.summaryTitle}>CVSS v3.0 base score</h2>
            <div className={styles.summaryBody}>
              <ColumnChart
                data={scoreBands}
                height={104}
                label="Rated findings per CVSS v3.0 base score band"
              />
              {unratedCount > 0 && (
                <span className={styles.summaryFootnote}>
                  {unratedCount} not rated · excluded from score bands
                </span>
              )}
            </div>
          </div>
        </div>

        <div className={styles.summaryCell}>
          <div className={styles.summaryCard}>
            <h2 className={styles.summaryTitle}>Exploitation</h2>
            <div className={styles.exploitSplit}>
              <span
                className={styles.exploitBar}
                role="img"
                aria-label={`${exploitedCount} exploited, ${unverifiedCount} unverified`}
              >
                <span
                  className={styles.exploitSeg}
                  data-tone="danger"
                  style={{
                    width: `${
                      vulnerabilities.length
                        ? (exploitedCount / vulnerabilities.length) * 100
                        : 0
                    }%`,
                  }}
                />
              </span>
              <span className={styles.exploitLegend}>
                <span className={styles.exploitItem}>
                  <b>{exploitedCount}</b>
                  <i className={styles.legendDot} data-tone="danger" />
                  Exploited
                </span>
                <span className={styles.exploitItem}>
                  <b>{unverifiedCount}</b>
                  <i className={styles.legendDot} data-tone="mute" />
                  Unverified
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* The record: the filter, then one row per finding. */}
      <section className={styles.records} aria-label="Finding records">
        <div className={styles.controls}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="Search findings"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            allowClear
            className={styles.search}
            aria-label="Search findings"
          />
          <Select
            value={severity}
            onChange={setSeverity}
            className={styles.filter}
            aria-label="Filter by severity"
            options={[
              { value: "all", label: "All severities" },
              ...severityLevels.map((level) => ({
                value: level.key,
                label: `${level.label} (${level.count})`,
              })),
            ]}
          />
          <Select
            value={owaspFilter}
            onChange={setOwaspFilter}
            className={styles.filterWide}
            aria-label="Filter by OWASP category"
            options={owaspOptions}
          />
          {hasFilters && (
            <Button size="small" type="text" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            compact
            icon={<FiAlertTriangle />}
            title="No findings match these filters"
            description="Widen the severity or OWASP filters, or clear the search box."
            actions={
              <Button size="small" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className={styles.table}>
            <div className={styles.head} aria-hidden="true">
              <span>Severity</span>
              <span>Finding</span>
              <span>CVSS v3.0</span>
              <span>Exploitation</span>
              <span>OWASP Top 10:2025</span>
              <span />
            </div>

            {filtered.map((item, index) => (
              <AnimatedContent
                key={item.vulnerabilityId}
                className={styles.row}
                direction="none"
                delay={Math.min(index, 12) * 22}
                onClick={() => openFinding(item)}
              >
                <span className={styles.identity}>
                  <SeverityBadge severity={item.severity} />
                </span>

                <span className={styles.findingCell}>
                  {/* The title is the real control: the row click is a mouse
                      convenience, so the link carries the keyboard path. */}
                  <Link
                    href={`/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`}
                    className={styles.findingTitle}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {item.title}
                  </Link>
                  <span className={styles.findingContext}>
                    {item.contextSummary ||
                      item.description ||
                      "No context summary provided"}
                  </span>
                </span>

                <span className={styles.scoreCell}>
                  {item.cvss?.score != null ? (
                    <>
                      <b>{Number(item.cvss.score).toFixed(1)}</b>
                      <span className={styles.scoreVector} title={item.cvss.vector}>
                        {item.cvss.vector}
                      </span>
                    </>
                  ) : (
                    <span className={styles.scoreNone}>not rated</span>
                  )}
                </span>

                <span className={styles.exploitCell}>
                  <span
                    className={`${styles.exploitBadge} ${
                      item.exploited ? styles.exploited : styles.unverified
                    }`}
                    title={
                      item.exploited
                        ? "Confirmed by the agent"
                        : "Seen by the agent, not yet proven exploitable"
                    }
                  >
                    {item.exploited ? "Exploited" : "Unverified"}
                  </span>
                </span>

                <span className={styles.owaspCell}>
                  {item.owaspTop10 ? (
                    <span
                      className={styles.owaspBadge}
                      title={item.owaspRationale || item.owaspTop10Title || ""}
                    >
                      {item.owaspTop10}
                      {item.owaspTop10Title ? ` ${item.owaspTop10Title}` : ""}
                    </span>
                  ) : (
                    <span className={styles.unmapped}>Unmapped</span>
                  )}
                </span>

                <span className={styles.openCell}>
                  <RightOutlined className={styles.openIcon} aria-hidden="true" />
                </span>
              </AnimatedContent>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
