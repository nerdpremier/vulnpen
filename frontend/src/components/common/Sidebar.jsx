"use client";

import React, { useCallback, useEffect, useMemo } from "react";
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
import {
  HiOutlineChevronDoubleLeft,
  HiOutlineChevronDoubleRight,
  HiOutlineChevronLeft,
} from "react-icons/hi";
import { isScanLive } from "@/utils/scans.mjs";
import { scansKey, testPlanKey } from "@/utils/scanQueryKeys.mjs";
import { useAgentStreamStore } from "@/store/agentStream.store";
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
 *
 * The rail collapses to an icon-only strip on the user's say-so, because the
 * pages behind it (the chat, an embedded desktop) are the ones that want the
 * width. Collapsing is a preference rather than engagement data, so it is
 * remembered in localStorage as well as in the per-session store slice — see
 * `RAIL_EXPANDED_KEY`. The width itself is published as `--moon-rail-w` on the
 * session page (see `Session.module.scss`) so the account dock, which is
 * rendered by the header outside this component, cannot drift out of step.
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

/**
 * Whether the rail is expanded, as "1" / "0". Global rather than per session:
 * how much room the user wants for the page is a habit, not a property of one
 * engagement, and a rail that re-expanded on every new session would have to
 * be collapsed again every time.
 */
const RAIL_EXPANDED_KEY = "vulnpen.rail.expanded";

const Sidebar = ({ sessionId, workspaceId }) => {
  const pathname = usePathname();
  const base = `/session/${sessionId}`;

  const expanded = useAgentStreamStore(
    (state) => state.sessions[sessionId]?.sidebarExpanded ?? true,
  );

  // The engagement's own numbers. These share query keys with the pages that
  // show the same data, so the rail costs no extra requests while a page is
  // open and keeps its badges in step with it.
  const { data: sessionInfo } = useQuery(
    ["session-info", sessionId],
    () => getSessionInfo(sessionId),
    { enabled: !!sessionId, refetchInterval: 10000, retry: false },
  );
  const { data: testPlanData } = useQuery(
    testPlanKey(sessionId),
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, refetchInterval: 15000, retry: false },
  );
  const { data: vulnerabilitiesData } = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
    { enabled: !!sessionId, refetchInterval: 5000, retry: false },
  );
  const { data: scansData } = useQuery(
    scansKey(sessionId),
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

  /**
   * Restore the remembered width after mount, never during render: the server
   * has no localStorage, so reading it earlier would make the first client
   * render disagree with the HTML it is hydrating.
   */
  useEffect(() => {
    if (!sessionId) return;
    let saved = null;
    try {
      saved = window.localStorage.getItem(RAIL_EXPANDED_KEY);
    } catch {
      // Storage unavailable (private mode, blocked cookies): keep the default.
      return;
    }
    if (saved !== "1" && saved !== "0") return;
    const store = useAgentStreamStore.getState();
    // The slice is normally created by AgentStreamConnector; create it here
    // too so the preference lands whichever effect runs first.
    store.getOrCreate(sessionId);
    store.setSidebarExpanded(sessionId, saved === "1");
  }, [sessionId]);

  const toggleRail = useCallback(() => {
    const store = useAgentStreamStore.getState();
    const next = !(store.sessions[sessionId]?.sidebarExpanded ?? true);
    store.getOrCreate(sessionId);
    store.setSidebarExpanded(sessionId, next);
    try {
      window.localStorage.setItem(RAIL_EXPANDED_KEY, next ? "1" : "0");
    } catch {
      // Failing to remember the choice is better than failing to make it.
    }
  }, [sessionId]);

  const coverage = testPlanData?.coverage;
  const liveScans = (scansData?.runs ?? []).filter(isScanLive).length;
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
  const exitLabel = workspaceId ? "Back to workspace" : "Back to dashboard";
  // Names the element the toggle shows and hides, so the control says what it
  // does rather than only what state it is in.
  const navId = `session-rail-${sessionId}`;

  return (
    <aside className={styles.sidebar} aria-label="Engagement navigation">
      <div className={styles.sidebarTop}>
        <Link
          href={exitHref}
          className={styles.navRow}
          aria-label={exitLabel}
          title={workspaceId ? "Workspace" : "Dashboard"}
        >
          <HiOutlineChevronLeft size={13} />
          <span>{workspaceId ? "Workspace" : "Dashboard"}</span>
        </Link>
        <button
          type="button"
          className={styles.railToggle}
          onClick={toggleRail}
          aria-expanded={expanded}
          aria-controls={navId}
          aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
          title={expanded ? "Collapse navigation" : "Expand navigation"}
        >
          {expanded ? (
            <HiOutlineChevronDoubleLeft />
          ) : (
            <HiOutlineChevronDoubleRight />
          )}
        </button>
      </div>

      <nav className={styles.sidebarNav} id={navId}>
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
                  // The collapsed rail shows icons only, so the label has to be
                  // reachable some other way; it also covers the truncation of
                  // the longest entries in the 216px step.
                  title={badge ? `${item.label} — ${badge}` : item.label}
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
