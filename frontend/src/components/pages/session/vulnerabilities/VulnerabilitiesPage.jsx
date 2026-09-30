"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Input, Select, Spin } from "antd";
import { SearchOutlined, RightOutlined } from "@ant-design/icons";
import Link from "next/link";
import {
  FiAlertOctagon,
  FiAlertTriangle,
  FiTarget,
  FiHelpCircle,
  FiShield,
} from "react-icons/fi";
import { getVulnerabilities } from "@/services/agent.service";
import { getTestPlan } from "@/services/websecurity.service";
import styles from "@/styles/pages/Vulnerabilities.module.scss";
import { AnimatedContent, EmptyState, StatTile } from "@/components/common/ui";

const SEVERITY_ORDER = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

function SeverityBadge({ severity }) {
  const value = severity || "medium";
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
  const { data, isLoading, isError } = useQuery(
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
        const delta =
          (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
        return (
          delta ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
  }, [vulnerabilities, search, severity, owaspFilter]);

  const counts = useMemo(
    () => ({
      critical: vulnerabilities.filter((item) => item.severity === "critical")
        .length,
      high: vulnerabilities.filter((item) => item.severity === "high").length,
      exploited: vulnerabilities.filter((item) => item.exploited).length,
      unmapped: vulnerabilities.filter((item) => !item.owaspTop10).length,
    }),
    [vulnerabilities],
  );

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
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Engagement findings</span>
          <h1>Vulnerabilities</h1>
          <p>
            Every finding the orchestrator recorded, with the WSTG case and the
            OWASP Top 10:2025 category it maps to.
          </p>
        </div>
        <div className={styles.totalBadge}>
          {vulnerabilities.length} findings
        </div>
      </header>

      <section className={styles.metrics} aria-label="Finding summary">
        <StatTile
          label="Total"
          value={vulnerabilities.length}
          icon={<FiShield />}
          active={severity === "all"}
          onClick={() => setSeverity("all")}
        />
        <StatTile
          label="Critical"
          value={counts.critical}
          tone="danger"
          icon={<FiAlertOctagon />}
          active={severity === "critical"}
          onClick={() => setSeverity("critical")}
        />
        <StatTile
          label="High"
          value={counts.high}
          tone="warning"
          icon={<FiAlertTriangle />}
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
      </section>

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
          <div className={styles.centerState}>
            <Spin />
          </div>
        ) : isError ? (
          <div className={styles.centerState}>
            Could not load vulnerabilities. The session may have expired.
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon={<FiShield />}
            title={
              vulnerabilities.length
                ? "No findings match these filters"
                : "No vulnerabilities recorded yet"
            }
            description={
              vulnerabilities.length
                ? "Widen the severity or OWASP filters, or clear the search box."
                : "Ask the orchestrator to test the target. Findings appear here the moment they are recorded."
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
                  <th scope="col">CVSS</th>
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
                    tabIndex={0}
                    onClick={() =>
                      router.push(
                        `/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`,
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter")
                        router.push(
                          `/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`,
                        );
                    }}
                  >
                    <td>
                      <SeverityBadge severity={item.severity} />
                    </td>
                    <td>
                      <strong className={styles.findingTitle}>
                        {item.title}
                      </strong>
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
                    <td>{item.cvssScore ?? "none"}</td>
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
                      <RightOutlined className={styles.openIcon} />
                    </td>
                  </AnimatedContent>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
