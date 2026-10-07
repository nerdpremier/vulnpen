"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "react-query";
import { getScans, getTestPlan } from "@/services/websecurity.service";
import { getSessionInfo, getVulnerabilities } from "@/services/agent.service";
import {
  FiAlertOctagon,
  FiCheckSquare,
  FiFileText,
  FiHome,
  FiMessageSquare,
  FiMonitor,
  FiPlayCircle,
  FiZap,
} from "react-icons/fi";
import { HiOutlineChevronLeft } from "react-icons/hi";
import { isScanLive } from "@/utils/scans.mjs";
import styles from "@/styles/pages/Session.module.scss";

/**
 * Engagement rail.
 *
 * Every entry is a real link to a real route, so middle-click, "open in new
 * tab", prefetch and the browser's own back behaviour all work the way a user
 * expects. The active entry is derived from the pathname and announced with
 * `aria-current`, and the badges are live numbers, not decoration.
 *
 * Groups follow the work: what the engagement contains, the agent that does
 * the work, and the tools it works through.
 */

const GROUPS = [
  {
    label: "Engagement",
    items: [
      {
        key: "overview",
        href: "",
        label: "Overview",
        icon: <FiHome />,
        exact: true,
      },
      { key: "test-plan", href: "/test-plan", label: "Test plan", icon: <FiCheckSquare /> },
      { key: "scans", href: "/scans", label: "Scans", icon: <FiPlayCircle /> },
      {
        key: "vulnerabilities",
        href: "/vulnerabilities",
        label: "Vulnerabilities",
        icon: <FiAlertOctagon />,
      },
      { key: "report", href: "/report", label: "Report", icon: <FiFileText /> },
    ],
  },
  {
    label: "Agent",
    items: [
      {
        key: "chat",
        href: "/chat",
        label: "Chat",
        icon: <FiMessageSquare />,
        live: true,
      },
    ],
  },
  {
    label: "Tools",
    items: [
      { key: "burp", href: "/burp", label: "Burp proxy", icon: <FiZap /> },
      { key: "gui", href: "/gui", label: "Desktop", icon: <FiMonitor /> },
    ],
  },
];

const LIVE_SCAN_STATES = ["queued", "running"];

const Sidebar = ({ sessionId, workspaceId }) => {
  const pathname = usePathname();
  const base = `/session/${sessionId}`;

  // The engagement's own numbers. These share query keys with the pages that
  // show the same data, so the rail costs no extra requests while a page is
  // open and keeps its badges in step with it.
  const { data: sessionInfo } = useQuery(
    ["session-info", sessionId],
    () => getSessionInfo(sessionId),
    { enabled: !!sessionId, refetchInterval: 10000, retry: false },
  );
  const { data: testPlanData } = useQuery(
    ["test-plan", sessionId],
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, refetchInterval: 15000, retry: false },
  );
  const { data: vulnerabilitiesData } = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
    { enabled: !!sessionId, refetchInterval: 5000, retry: false },
  );
  const { data: scansData } = useQuery(
    ["scans", sessionId],
    () => getScans(sessionId),
    {
      enabled: !!sessionId,
      retry: false,
      // Poll only while something is actually moving: a settled history never
      // changes on its own.
      refetchInterval: (data) =>
        (data?.runs ?? []).some(isScanLive) ? 5000 : false,
    },
  );

  const coverage = testPlanData?.coverage;
  const liveScans = (scansData?.runs ?? []).filter((scan) =>
    LIVE_SCAN_STATES.includes(scan.status),
  ).length;
  const vulnerabilities = vulnerabilitiesData?.total ?? 0;
  const agentRunning = sessionInfo?.agentState === "running";

  const badges = useMemo(
    () => ({
      "test-plan": coverage?.total > 0 ? `${coverage.executed}/${coverage.total}` : null,
      scans: liveScans > 0 ? liveScans : null,
      vulnerabilities: vulnerabilities > 0 ? vulnerabilities : null,
    }),
    [coverage, liveScans, vulnerabilities],
  );

  const isActive = (item) => {
    if (item.exact) return pathname === base || pathname === `${base}/`;
    return pathname?.startsWith(`${base}${item.href}`);
  };

  const exitHref = workspaceId ? `/workspace/${workspaceId}` : "/dashboard";

  return (
    <aside className={styles.sidebar} aria-label="Engagement navigation">
      <div className={styles.sidebarTop}>
        <Link
          href={exitHref}
          className={styles.navRow}
          aria-label={workspaceId ? "Back to workspace" : "Back to dashboard"}
        >
          <HiOutlineChevronLeft size={13} />
          <span>{workspaceId ? "Workspace" : "Dashboard"}</span>
        </Link>
      </div>

      <nav className={styles.sidebarNav}>
        {GROUPS.map((group) => (
          <React.Fragment key={group.label}>
            <div className={styles.navSectionLabel}>{group.label}</div>
            {group.items.map((item) => {
              const active = isActive(item);
              const badge = badges[item.key];
              return (
                <Link
                  key={item.key}
                  href={`${base}${item.href}`}
                  className={active ? styles.activeTab : styles.tab}
                  aria-current={active ? "page" : undefined}
                  aria-label={item.label}
                >
                  {item.icon}
                  <span className={styles.navText}>{item.label}</span>
                  {item.live && agentRunning && (
                    <span className={styles.navLive} aria-label="agent running" />
                  )}
                  {badge && <span className={styles.navBadge}>{badge}</span>}
                </Link>
              );
            })}
          </React.Fragment>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
