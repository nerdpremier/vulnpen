"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Button, Tooltip } from "antd";
import {
  DesktopOutlined,
  MessageOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { connectToVNC } from "@/services/infra.service";
import { getVNCConfig } from "@/services/user.service";
import { PageShell, PageState } from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
import styles from "@/styles/components/Desktop.module.scss";

/**
 * The engagement's graphical desktop: a VNC session in an iframe.
 *
 * The desktop IS the page — the frame takes every pixel the shell does not, and
 * the controls (reconnect, setup, the agent's chat) ride in the shared header
 * slot rather than in a page header of their own. The three states that are not
 * a live desktop — nothing configured, unreachable, still opening — each say
 * what to do next; the readout band that used to sit above the frame is gone,
 * because a desktop that fills the screen has no room to spend on its own
 * metadata.
 */

/** Settings owns desktop setup; open it on the tab that can install one. */
const openConnectionSettings = () => {
  window.dispatchEvent(
    new CustomEvent("open-settings", { detail: { tab: "connection" } })
  );
};

export default function DesktopPage({ sessionId }) {
  const router = useRouter();
  const [frameReady, setFrameReady] = useState(false);
  const frameRef = useRef(null);

  const configQuery = useQuery(
    ["vnc-config", sessionId || "global"],
    getVNCConfig,
    { staleTime: 30000 },
  );
  const configured = configQuery.data?.configured === true;

  const desktopQuery = useQuery(
    ["vnc-connect", sessionId],
    () => connectToVNC({ session_id: sessionId }),
    {
      enabled: configured,
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  );

  const hasSession = Boolean(desktopQuery.data);

  /* The desktop's own controls, in the same header slot every session page
     uses: reconfigure it, reconnect it, or hand the operator to the agent. */
  const actions = useMemo(
    () => (
      <>
        <Tooltip title="Reconnect the desktop">
          <Button
            icon={<ReloadOutlined />}
            loading={desktopQuery.isFetching}
            disabled={!configured}
            onClick={() => desktopQuery.refetch()}
            aria-label="Reconnect the desktop"
          />
        </Tooltip>
        <Button
          icon={<SettingOutlined />}
          onClick={openConnectionSettings}
        >
          Desktop setup
        </Button>
        <Button
          type="primary"
          icon={<MessageOutlined />}
          onClick={() => router.push(`/session/${sessionId}/chat`)}
        >
          Agent chat
        </Button>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, router, configured, desktopQuery.isFetching],
  );
  usePublishHeaderActions(actions);

  if (configQuery.isLoading) {
    return (
      <PageShell width="full">
        <PageState state="loading" rows={3} />
      </PageShell>
    );
  }

  if (configQuery.isError) {
    /* A failed read is not "nothing configured": sending the operator to
       reinstall a desktop that already exists is the destructive version of
       this mistake. */
    return (
      <PageShell width="full">
        <PageState
          state="error"
          title="Could not read the desktop configuration"
          description="This screen cannot tell whether a desktop is installed. Nothing has been changed."
          onRetry={() => configQuery.refetch()}
        />
      </PageShell>
    );
  }

  if (!configured) {
    return (
      <PageShell width="full">
        <PageState
          state="empty"
          icon={<DesktopOutlined />}
          title="No desktop configured"
          description="Install a desktop on this host, or point VulnPen at an existing VNC server — both live in Settings → Connection."
          actions={
            <Button type="primary" icon={<SettingOutlined />} onClick={openConnectionSettings}>
              Configure the desktop
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (desktopQuery.isError) {
    return (
      <PageShell width="full">
        <PageState
          state="error"
          title="Could not reach the desktop"
          description={
            desktopQuery.error?.response?.data?.message ||
            "The API could not open a VNC session. Check that the workspace host is reachable from this browser — the desktop's own address has to resolve for you, not just for the API."
          }
          onRetry={() => desktopQuery.refetch()}
          actions={
            <Button icon={<SettingOutlined />} onClick={openConnectionSettings}>
              Check the connection
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (desktopQuery.isLoading || !desktopQuery.data) {
    return (
      <PageShell width="full">
        <PageState state="loading" variant="spinner" />
      </PageShell>
    );
  }

  const { vncURL, password } = desktopQuery.data;
  const base =
    vncURL?.startsWith("http://") || vncURL?.startsWith("https://")
      ? vncURL
      : `http://${vncURL}`;

  return (
    <PageShell
      width="full"
      className={styles.desktopPage}
      innerClassName={styles.desktopInner}
    >
      {/* The desktop, edge to edge. The iframe only re-measures on mount and on
          resize, so the frame is the whole remaining column and nothing else
          competes for it. */}
      <div
        ref={frameRef}
        className={`${styles.frame} ${frameReady ? "" : styles.frameLoading}`}
      >
        <iframe
          className={styles.canvas}
          title="Remote desktop"
          src={`${base}/vnc.html?password=${encodeURIComponent(password)}&resize=scale&autoconnect=true`}
          allow="fullscreen; clipboard-read; clipboard-write"
          onLoad={() => setFrameReady(true)}
        />
        {!frameReady && (
          <p className={styles.frameHint} role="status">
            <span
              className={`${styles.pulseDot} ${styles.pulseDotSeeking}`}
              aria-hidden="true"
            />
            Opening the desktop…
          </p>
        )}
      </div>
    </PageShell>
  );
}

