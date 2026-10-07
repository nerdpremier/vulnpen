"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Input, Select } from "antd";
import { SearchOutlined, RightOutlined } from "@ant-design/icons";
import Link from "next/link";
import { FiAlertTriangle } from "react-icons/fi";
import { getVulnerabilities } from "@/services/agent.service";
import styles from "@/styles/pages/Vulnerabilities.module.scss";
import {
  AnimatedContent,
  ColumnChart,
  DonutChart,
  EmptyState,
  PageHeader,
  PageShell,
  PageState,
  SeverityBar,
  SpotlightCard,
} from "@/components/common/ui";
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

  /* ---- The summary band: shapes over the same list the table shows --------
     These read the whole engagement, not the filtered view: a summary that
     redraws itself every keystroke stops being a reference. */
  const severityLevels = useMemo(
    () => findingsBySeverity(vulnerabilities).levels,
    [vulnerabilities],
  );

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

  const exploitation = useMemo(
    () => [
      {
        key: "exploited",
        label: "Exploited",
        tone: "danger",
        value: vulnerabilities.filter((item) => item.exploited).length,
      },
      {
        key: "unverified",
        label: "Unverified",
        tone: "mute",
        value: vulnerabilities.filter((item) => !item.exploited).length,
      },
    ],
    [vulnerabilities],
  );

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
  return (
    <PageShell>
      <PageHeader
        eyebrow="Engagement"
        title="Vulnerabilities"
      />

      {/* Three complementary views: severity, rated CVSS scores and proof of
          exploitation. The detailed finding inventory lives below. */}
      {vulnerabilities.length > 0 && (
        <section className={styles.summaryBand} aria-label="Finding overview">
          <AnimatedContent delay={0} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>Severity mix</h2>
              <div className={styles.summaryBody}>
                <SeverityBar levels={severityLevels} />
              </div>
            </SpotlightCard>
          </AnimatedContent>

          <AnimatedContent delay={70} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
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
            </SpotlightCard>
          </AnimatedContent>

          <AnimatedContent delay={140} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>Exploitation</h2>
              <div className={styles.summaryBody}>
                <DonutChart
                  segments={exploitation}
                  size={118}
                  thickness={14}
                  centerValue={vulnerabilities.length}
                  centerLabel="findings"
                  legend="inline"
                  className={styles.donutCentered}
                />
              </div>
            </SpotlightCard>
          </AnimatedContent>
        </section>
      )}

      <section className={styles.tableCard}>
        <div className={styles.toolbar}>
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
              { value: "critical", label: "Critical" },
              { value: "high", label: "High" },
              { value: "medium", label: "Medium" },
              { value: "low", label: "Low" },
              { value: "info", label: "Info" },
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
            <button
              type="button"
              className={styles.clearFilters}
              onClick={clearFilters}
            >
              Clear filters
            </button>
          )}
        </div>
        {isLoading ? (
          <PageState state="loading" rows={5} />
        ) : isError ? (
          <PageState
            state="error"
            title="Could not load the findings"
            description="The findings could not be read. The page keeps polling; retry to see them now."
            onRetry={() => refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon={<FiAlertTriangle />}
            title={
              vulnerabilities.length
                ? "No findings match these filters"
                : "No vulnerabilities recorded yet"
            }
            description={
              vulnerabilities.length
                ? "Widen the severity or OWASP filters, or clear the search box."
                : undefined
            }
            actions={
              vulnerabilities.length ? (
                <button
                  type="button"
                  className={styles.clearFilters}
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              ) : null
            }
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Finding</th>
                  <th scope="col">CVSS v3.0</th>
                  <th scope="col">Exploitation</th>
                  <th scope="col">OWASP Top 10:2025</th>
                  <th scope="col" aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, index) => (
                  <AnimatedContent
                    key={item.vulnerabilityId}
                    as="tr"
                    direction="none"
                    delay={Math.min(index, 12) * 24}
                    onClick={() =>
                      router.push(
                        `/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`,
                      )
                    }
                  >
                    <td>
                      <SeverityBadge severity={item.severity} />
                    </td>
                    <td>
                      {/* The title is the real control: the row click is a mouse
                          convenience, so the link carries the keyboard path,
                          the focus ring and open-in-new-tab. */}
                      <Link
                        href={`/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`}
                        className={styles.findingLink}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <strong className={styles.findingTitle}>
                          {item.title}
                        </strong>
                      </Link>
                      <span className={styles.findingContext}>
                        {item.contextSummary ||
                          item.description ||
                          "No context summary provided"}
                      </span>
                    </td>
                    <td>
                      {item.cvss?.score != null
                        ? `${item.cvss.score} (${item.cvss.vector})`
                        : "not rated"}
                    </td>
                    <td>
                      <span
                        className={
                          item.exploited
                            ? `${styles.exploitBadge} ${styles.exploited}`
                            : `${styles.exploitBadge} ${styles.unverified}`
                        }
                        title={
                          item.exploited
                            ? "Confirmed by the agent"
                            : "Seen by the agent, not yet proven exploitable"
                        }
                      >
                        {item.exploited ? "Exploited" : "Unverified"}
                      </span>
                    </td>
                    <td>
                      {item.owaspTop10 ? (
                        <span
                          className={styles.owaspBadge}
                          title={
                            item.owaspRationale || item.owaspTop10Title || ""
                          }
                        >
                          {item.owaspTop10}
                          {item.owaspTop10Title
                            ? ` ${item.owaspTop10Title}`
                            : ""}
                        </span>
                      ) : (
                        <span className={styles.unmapped}>Unmapped</span>
                      )}
                    </td>
                    <td>
                      <RightOutlined
                        className={styles.openIcon}
                        aria-hidden="true"
                      />
                    </td>
                  </AnimatedContent>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageShell>
  );
}
