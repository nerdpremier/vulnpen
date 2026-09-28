"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Empty, Input, Select, Spin } from "antd";
import { SearchOutlined, RightOutlined } from "@ant-design/icons";
import { getVulnerabilities } from "@/services/agent.service";
import styles from "@/styles/pages/Vulnerabilities.module.scss";

const SEVERITY_ORDER = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

function SeverityBadge({ severity }) {
  const value = severity || "medium";
  return <span className={`${styles.severity} ${styles[value]}`}>{value}</span>;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
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
        const delta = (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
        return delta || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [vulnerabilities, search, severity, owaspFilter]);

  const counts = useMemo(() => ({
    critical: vulnerabilities.filter((item) => item.severity === "critical").length,
    high: vulnerabilities.filter((item) => item.severity === "high").length,
    exploited: vulnerabilities.filter((item) => item.exploited).length,
    unmapped: vulnerabilities.filter((item) => !item.owaspTop10).length,
  }), [vulnerabilities]);

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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Engagement findings</span>
          <h1>Vulnerabilities</h1>
          <p>Security findings recorded by the orchestrator and racers.</p>
        </div>
        <div className={styles.totalBadge}>{vulnerabilities.length} findings</div>
      </header>

      <section className={styles.metrics}>
        <div className={styles.metric}><span>Total</span><strong>{vulnerabilities.length}</strong></div>
        <div className={`${styles.metric} ${styles.metricCritical}`}><span>Critical</span><strong>{counts.critical}</strong></div>
        <div className={`${styles.metric} ${styles.metricHigh}`}><span>High</span><strong>{counts.high}</strong></div>
        <div className={styles.metric}><span>Exploited</span><strong>{counts.exploited}</strong></div>
        <div className={`${styles.metric} ${styles.metricUnmapped}`}>
          <span>Unmapped OWASP</span><strong>{counts.unmapped}</strong>
        </div>
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
          />
          <Select
            value={severity}
            onChange={setSeverity}
            className={styles.filter}
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
            options={owaspOptions}
          />
        </div>

        {isLoading ? (
          <div className={styles.centerState}><Spin /></div>
        ) : isError ? (
          <div className={styles.centerState}>Could not load vulnerabilities.</div>
        ) : filtered.length === 0 ? (
          <div className={styles.centerState}>
            <Empty description={vulnerabilities.length ? "No findings match these filters" : "No vulnerabilities recorded yet"} />
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Severity</th><th>Finding</th><th>Affected asset</th><th>CVSS</th>
                  <th>Classification</th><th>WSTG</th><th>OWASP Top 10:2025</th>
                  <th>Status</th><th>Updated</th><th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr
                    key={item.vulnerabilityId}
                    tabIndex={0}
                    onClick={() => router.push(`/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") router.push(`/session/${sessionId}/vulnerabilities/${item.vulnerabilityId}`);
                    }}
                  >
                    <td><SeverityBadge severity={item.severity} /></td>
                    <td>
                      <strong className={styles.findingTitle}>{item.title}</strong>
                      <span className={styles.findingContext}>{item.contextSummary || item.description || "No context summary provided"}</span>
                    </td>
                    <td>
                      <span className={styles.asset}>{item.host || "unknown"}</span>
                      <span className={styles.assetMeta}>{item.endpoint || item.service || "—"}</span>
                    </td>
                    <td>{item.cvssScore ?? "—"}</td>
                    <td>{item.cwe || item.cve || "—"}</td>
                    <td>
                      {item.wstgId ? (
                        <span className={styles.wstgRef} title={item.wstgTitle || item.wstgId}>
                          {item.wstgId}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
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
                    </td>
                    <td><span className={styles.status}>{item.status}</span></td>
                    <td className={styles.updated}>{formatDate(item.updatedAt)}</td>
                    <td><RightOutlined className={styles.openIcon} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
