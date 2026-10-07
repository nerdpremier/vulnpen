"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Input, Select } from "antd";
import { SearchOutlined, RightOutlined } from "@ant-design/icons";
import Link from "next/link";
import {
  FiAlertOctagon,
  FiAlertTriangle,
  FiTarget,
  FiHelpCircle,
  FiCrosshair,
} from "react-icons/fi";
import { getVulnerabilities } from "@/services/agent.service";
import { getTestPlan } from "@/services/websecurity.service";
import styles from "@/styles/pages/Vulnerabilities.module.scss";
import {
  AnimatedContent,
  BarList,
  ColumnChart,
  DonutChart,
  EmptyState,
  PageHeader,
  PageShell,
  PageState,
  SeverityBar,
  Sparkline,
  SpotlightCard,
  StatStrip,
  StatTile,
} from "@/components/common/ui";
import {
  SEVERITY_LEVELS,
  compareBySeverity,
  findingsBySeverity,
  severityRank,
} from "@/utils/findings.mjs";

/** CVSS v3.0 base-score bands, the same cut points the severity ramp uses. */
const CVSS_BANDS = [
  { key: "low", label: "0.1–3.9", tone: "low", min: 0.1, max: 4 },
  { key: "medium", label: "4.0–6.9", tone: "medium", min: 4, max: 7 },
  { key: "high", label: "7.0–8.9", tone: "high", min: 7, max: 9 },
  { key: "critical", label: "9.0–10", tone: "critical", min: 9, max: 10.1 },
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

function formatDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
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

  // Reuses the query the session rail already keeps warm: it carries the WSTG
  // catalogue, so a finding can name the category it came from.
  const { data: planData } = useQuery(
    ["test-plan", sessionId],
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, retry: false },
  );
  const categoryNames = useMemo(() => {
    const map = new Map();
    for (const category of planData?.catalog?.categories ?? []) {
      map.set(category.code, category.name);
    }
    return map;
  }, [planData]);

  /** "ATHN" -> "Authentication Testing" when the catalogue is available. */
  const categoryLabel = (code) => (code ? categoryNames.get(code) ?? code : "");

  const testPlanHref = (testId) =>
    `/session/${sessionId}/test-plan?case=${encodeURIComponent(testId)}`;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return vulnerabilities
      .filter((item) => severity === "all" || item.severity === severity)
      .filter((item) => {
        if (owaspFilter === "all") return true;
        if (owaspFilter === "unmapped") return !item.owaspTop10;
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

  const counts = useMemo(
    () => ({
      high: vulnerabilities.filter((item) => item.severity === "high").length,
      exploited: vulnerabilities.filter((item) => item.exploited).length,
      unmapped: vulnerabilities.filter((item) => !item.owaspTop10).length,
    }),
    [vulnerabilities],
  );

  /* ---- The summary band: shapes over the same list the table shows --------
     These read the whole engagement, not the filtered view: a summary that
     redraws itself every keystroke stops being a reference. */
  const severityLevels = useMemo(
    () => findingsBySeverity(vulnerabilities).levels,
    [vulnerabilities],
  );

  const scoreBands = useMemo(() => {
    const scored = vulnerabilities.filter((item) => cvssScoreOf(item) != null);
    const bands = CVSS_BANDS.map((band) => {
      const value = scored.filter((item) => {
        const score = cvssScoreOf(item);
        return score >= band.min && score < band.max;
      }).length;
      return {
        key: band.key,
        label: band.label,
        tone: band.tone,
        value,
        title: `CVSS ${band.label}: ${value} finding${value === 1 ? "" : "s"}`,
      };
    });
    const unrated = vulnerabilities.length - scored.length;
    return [
      ...bands,
      {
        key: "unrated",
        label: "not rated",
        tone: "mute",
        value: unrated,
        title: `${unrated} finding${unrated === 1 ? "" : "s"} with no CVSS base score`,
      },
    ];
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

  /* When the engagement found things, as a series. The span is bucketed into at
     most 14 equal slots instead of a fixed 14-day window, so an engagement that
     ran over two months still shows its own shape rather than one spike and a
     row of zeroes. */
  const discovery = useMemo(() => {
    const day = 86_400_000;
    const stamps = vulnerabilities
      .map((item) => new Date(item.createdAt).getTime())
      .filter((value) => Number.isFinite(value));
    if (stamps.length < 2) return null;

    const first = Math.min(...stamps);
    const last = Math.max(...stamps);
    const buckets = Math.max(2, Math.min(14, Math.round((last - first) / day) + 1));
    const width = (last - first + 1) / buckets;
    const series = new Array(buckets).fill(0);
    for (const stamp of stamps) {
      const index = Math.min(buckets - 1, Math.floor((stamp - first) / width));
      series[index] += 1;
    }

    const spanDays = Math.round((last - first) / day) + 1;
    return {
      series,
      scope: spanDays <= 1 ? "one day" : `${spanDays} days`,
    };
  }, [vulnerabilities]);

  /* Ranked by volume, tinted by the worst severity recorded on that asset, so
     "four findings here" and "four low findings here" are different rows. */
  const busiestAssets = useMemo(() => {
    const byHost = new Map();
    for (const item of vulnerabilities) {
      const key = item.host || "unknown";
      const entry =
        byHost.get(key) ?? { key, label: key, value: 0, worst: SEVERITY_LEVELS.length };
      entry.value += 1;
      entry.worst = Math.min(entry.worst, severityRank(item.severity));
      byHost.set(key, entry);
    }
    return [...byHost.values()]
      .sort((a, b) => b.value - a.value || a.worst - b.worst)
      .slice(0, 5)
      .map((entry) => {
        const worst = SEVERITY_LEVELS[entry.worst];
        return {
          key: entry.key,
          label: entry.label,
          value: entry.value,
          tone: worst?.key ?? "mute",
          hint: `${entry.label}: ${entry.value} finding${
            entry.value === 1 ? "" : "s"
          } · worst ${worst?.label.toLowerCase() ?? "unknown"}`,
        };
      });
  }, [vulnerabilities]);

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
      { value: "unmapped", label: "Unmapped" },
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
        description="Every finding in this engagement, highest severity first."
      />

      <StatStrip className={styles.metrics} aria-label="Finding summary">
        <StatTile
          label="Total"
          value={vulnerabilities.length}
          icon={<FiCrosshair />}
          active={severity === "all"}
          onClick={() => setSeverity("all")}
        />
        <StatTile
          label="High"
          value={counts.high}
          tone="warning"
          icon={<FiAlertOctagon />}
          active={severity === "high"}
          onClick={() => setSeverity("high")}
        />
        <StatTile
          label="Exploited"
          value={counts.exploited}
          tone="success"
          icon={<FiTarget />}
          hint="Confirmed by the agent"
        />
        <StatTile
          label="Unmapped OWASP"
          value={counts.unmapped}
          tone={counts.unmapped ? "warning" : "neutral"}
          icon={<FiHelpCircle />}
          active={owaspFilter === "unmapped"}
          onClick={() =>
            setOwaspFilter(owaspFilter === "unmapped" ? "all" : "unmapped")
          }
        />
      </StatStrip>

      {/* Five shapes over the same list the table shows: the mix, where it sits
          on the CVSS scale, whether it was proven, when it arrived and where it
          lives. Nothing appears until there is something to draw. */}
      {vulnerabilities.length > 0 && (
        <section className={styles.summaryBand} aria-label="Finding overview">
          <AnimatedContent delay={0} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>Severity mix</h2>
              <SeverityBar levels={severityLevels} />
            </SpotlightCard>
          </AnimatedContent>

          <AnimatedContent delay={70} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>CVSS v3.0 base score</h2>
              <ColumnChart
                data={scoreBands}
                height={78}
                label="Findings per CVSS v3.0 base score band"
              />
            </SpotlightCard>
          </AnimatedContent>

          <AnimatedContent delay={140} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>Exploitation</h2>
              <DonutChart
                segments={exploitation}
                size={112}
                thickness={13}
                centerValue={vulnerabilities.length}
                centerLabel="findings"
                legend="inline"
              />
            </SpotlightCard>
          </AnimatedContent>

          <AnimatedContent delay={210} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>
                Discovery
                {discovery && (
                  <span className={styles.summaryScope}>{discovery.scope}</span>
                )}
              </h2>
              {discovery ? (
                <Sparkline
                  values={discovery.series}
                  tone="accent"
                  height={62}
                  label={`Findings discovered over ${discovery.scope}`}
                />
              ) : (
                <p className={styles.summaryEmpty}>
                  Not enough dated findings to plot a trend yet.
                </p>
              )}
            </SpotlightCard>
          </AnimatedContent>

          <AnimatedContent delay={280} className={styles.summaryCell}>
            <SpotlightCard glare className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>Busiest assets</h2>
              <BarList items={busiestAssets} />
            </SpotlightCard>
          </AnimatedContent>
        </section>
      )}

      <section className={styles.tableCard}>
        <div className={styles.toolbar}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="Search title, asset, CWE or CVE"
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
            className={styles.filter}
            aria-label="Filter by OWASP category"
            options={owaspOptions}
          />
          <span className={styles.toolbarSpacer} />
          <span className={styles.resultCount}>
            {filtered.length} shown
          </span>
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
                  <th scope="col">Affected asset</th>
                  <th scope="col">CVSS v3.0</th>
                  <th scope="col">Classification</th>
                  <th scope="col">Test case</th>
                  <th scope="col">OWASP Top 10:2025</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
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
                      <span className={styles.asset}>
                        {item.host || "unknown"}
                      </span>
                      <span className={styles.assetMeta}>
                        {item.endpoint || item.service || "none recorded"}
                      </span>
                    </td>
                    <td>
                      {item.cvss?.score != null
                        ? `${item.cvss.score} (${item.cvss.vector})`
                        : "not rated"}
                    </td>
                    <td>{item.cwe || item.cve || "none"}</td>
                    <td>
                      {item.wstgId ? (
                        <Link
                          href={testPlanHref(item.wstgId)}
                          className={styles.wstgLink}
                          title={
                            item.wstgTitle
                              ? `${item.wstgId} - ${item.wstgTitle}`
                              : item.wstgId
                          }
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <span className={styles.wstgRef}>{item.wstgId}</span>
                          <span className={styles.wstgCategory}>
                            {categoryLabel(item.wstgCategory) ||
                              item.wstgTitle ||
                              "Test plan"}
                          </span>
                        </Link>
                      ) : (
                        <span className={styles.unmapped}>No test case</span>
                      )}
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
                      <span className={styles.status}>{item.status}</span>
                    </td>
                    <td className={styles.updated}>
                      {formatDate(item.updatedAt)}
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
