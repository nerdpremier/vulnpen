"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "@/styles/components/Common.module.scss";
import { useRouter } from "next/navigation";
import { App, Dropdown } from "antd";
import { useDispatch, useSelector } from "react-redux";
import { logoutUser } from "@/services/auth.service";
import { useMutation } from "react-query";
import Link from "next/link";
import {
  RiLogoutCircleRLine,
  RiSettings3Line,
  RiArrowDownSLine,
} from "react-icons/ri";

import { logout } from "@/store/user.slice";
import SettingsOverlay from "./SettingsOverlay";

/** First letters of the display name, for the account avatar. */
const initialsOf = (name) => {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/**
 * Sticky application header.
 *
 * Two shapes: outside a session it is the brand bar, inside a session it shows
 * the engagement context (workspace / session name / id) instead. The account
 * cluster is identical in both so settings and sign-out are always one click
 * away, and it collapses to icons on small screens.
 */
const HeaderLinks = ({
  sessionId,
  sessionName,
  sessionInfo,
  workspaceName,
  logoVisible = true,
}) => {
  const router = useRouter();
  const dispatch = useDispatch();
  const { user } = useSelector((state) => state.user);
  const { message } = App.useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState(null);

  const handleOpenSettings = useCallback((e) => {
    const tab = e.detail?.tab || null;
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener("open-settings", handleOpenSettings);
    return () => window.removeEventListener("open-settings", handleOpenSettings);
  }, [handleOpenSettings]);

  const logoutMutation = useMutation(logoutUser, {
    onSuccess: (data) => {
      router.push("/");
      dispatch(logout());
      message.success(data?.message ?? "Logged out successfully!");
    },
    onError: (err) => {
      message.error(
        err?.response?.data?.message ?? "Failed to logout. Please try again."
      );
    },
  });

  const resolvedSessionName = sessionName || sessionInfo?.name || null;
  const resolvedWorkspace = workspaceName || sessionInfo?.workspaceName || null;
  // The crumb names and links the engagement's parent workspace, so it is
  // navigation rather than decoration.
  const workspaceHref = sessionInfo?.workspaceId
    ? `/workspace/${sessionInfo.workspaceId}`
    : null;

  const accountMenu = {
    items: [
      {
        key: "settings",
        icon: <RiSettings3Line />,
        label: <span className={styles.menuItem}>Settings</span>,
      },
      { type: "divider" },
      {
        key: "logout",
        icon: <RiLogoutCircleRLine />,
        label: <span className={styles.menuDanger}>Log out</span>,
      },
    ],
    onClick: ({ key }) => {
      if (key === "settings") setSettingsOpen(true);
      if (key === "logout") logoutMutation.mutate();
    },
  };

  return (
    <>
      <header className={styles.headerLinkWrapper}>
        <div className={styles.headerLeft}>
          {sessionId ? (
            <div className={styles.sessionContext}>
              {workspaceHref ? (
                <Link href={workspaceHref} className={styles.sessionCrumb}>
                  {resolvedWorkspace
                    ? `Workspace / ${resolvedWorkspace}`
                    : "Workspace"}
                </Link>
              ) : (
                <span className={styles.sessionCrumb}>
                  {resolvedWorkspace ? `Workspace / ${resolvedWorkspace}` : "Engagement"}
                </span>
              )}
              {resolvedSessionName && (
                <span className={styles.sessionName} title={sessionId}>
                  {resolvedSessionName}
                </span>
              )}
            </div>
          ) : (
            <>
              {logoVisible ? (
                <Link href="/dashboard" className={styles.brandLink}>
                  <span className={styles.brandText}>
                    <span className={styles.brandName}>VulnPen</span>
                    <span className={styles.brandSub}>Web application security testing assistant</span>
                  </span>
                </Link>
              ) : (
                <div />
              )}
            </>
          )}
        </div>

        {!sessionId && (
          <div className={styles.options}>
            <Dropdown menu={accountMenu} trigger={["click"]} placement="bottomRight">
              <button type="button" className={styles.accountPill} aria-label="Account menu">
                <span className={styles.avatar}>{initialsOf(user?.name)}</span>
                <span className={styles.username}>{user?.name || "Account"}</span>
                <RiArrowDownSLine className={styles.accountCaret} />
              </button>
            </Dropdown>
          </div>
        )}
      </header>

      {/* Account placement follows the layout: pages with the session rail
          dock it to the bottom-left; plain pages keep it in the header. */}
      {sessionId && (
        <div className={styles.accountDock}>
          <Dropdown menu={accountMenu} trigger={["click"]} placement="topLeft">
            <button type="button" className={styles.account} aria-label="Account menu">
              <span className={styles.avatar}>{initialsOf(user?.name)}</span>
              <span className={styles.username}>{user?.name || "Account"}</span>
              <RiArrowDownSLine className={styles.accountCaret} />
            </button>
          </Dropdown>
        </div>
      )}

      <SettingsOverlay
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsInitialTab(null);
        }}
        initialTab={settingsInitialTab}
        sessionId={sessionId}
      />
    </>
  );
};

export default HeaderLinks;
