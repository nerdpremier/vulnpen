"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "react-query";
import { Button } from "antd";
import {
  DesktopOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { connectToVNC } from "@/services/infra.service";
import { getVNCConfig } from "@/services/user.service";
import {
  PageHeader,
  PageShell,
  PageState,
  StatStrip,
  StatTile,
} from "@/components/common/ui";
import styles from "@/styles/components/Desktop.module.scss";

/**
 * The engagement's graphical desktop: a VNC session in an iframe.
 *
 * Three states matter and each one now says what to do next — configuring a
 * desktop (which lives in Settings → Connection, the only place that can
 * actually install one), connecting, and connected/failed. The old route sent
 * both "fix it" buttons to `/session/<id>/connection`, a route that has never
 * existed, so the one screen that could unblock the user 404'd.
 *
 * Everything the readout band shows is either read from the API (target, setup
 * mode, credential) or measured from the frame itself (the pixels noVNC scales
 * the remote screen into). No frame rate, because nothing here reports one.
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

  // The frame is the viewport noVNC scales the remote screen into, so its own
  // size is the reading that matters — not the window's. Measured after the
  // frame mounts (the session has to arrive first) and on every resize.
  const [frameSize, setFrameSize] = useState(null);
  const hasSession = Boolean(desktopQuery.data);
  useEffect(() => {
    const node = frameRef.current;
    if (!node) return undefined;
    const read = () =>
      setFrameSize({
        width: node.clientWidth,
        height: node.clientHeight,
        dpr: window.devicePixelRatio || 1,
      });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasSession]);

  const header = (
    <PageHeader
      compact
      eyebrow="Engagement"
      title="Desktop"
      description="A screen on this engagement's workspace host, for tools that need one."
      back={
        <Button type="text" icon={<DesktopOutlined />} onClick={() => router.push(`/session/${sessionId}`)}>
          Overview
        </Button>
      }
      actions={
        <>
          <Button icon={<SettingOutlined />} onClick={openConnectionSettings}>
            Desktop setup
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={desktopQuery.isFetching}
            disabled={!configured}
            onClick={() => desktopQuery.refetch()}
          >
            Reconnect
          </Button>
        </>
      }
    />
  );

  if (configQuery.isLoading) {
    return (
      <PageShell width="full">
        {header}
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
        {header}
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
        {header}
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
        {header}
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
        {header}
        <PageState state="loading" variant="spinner" />
      </PageShell>
    );
  }

  const { vncURL, password, workHost } = desktopQuery.data;
  const base =
    vncURL?.startsWith("http://") || vncURL?.startsWith("https://")
      ? vncURL
      : `http://${vncURL}`;

  /* The viewer address as an operator reads it: host and port, not the whole
     URL. A saved address that does not parse is shown as saved. */
  let target = vncURL || "—";
  try {
    target = new URL(base).host || target;
  } catch {
    /* keep the raw value */
  }

  const config = configQuery.data ?? {};
  const link = desktopQuery.isFetching
    ? { value: "Linking", tone: "info" }
    : frameReady
      ? { value: "Live", tone: "success" }
      : { value: "Opening", tone: "warning" };
  const desktopState =
    config.mode === "manual"
      ? { value: "Manual", tone: "neutral", hint: "address set by hand" }
      : config.setupDone
        ? { value: "Provisioned", tone: "neutral", hint: "installed on the host" }
        : { value: "Pending", tone: "warning", hint: "install has not run" };

  return (
    <PageShell
      width="full"
      className={styles.desktopPage}
      innerClassName={styles.desktopInner}
    >
      {header}

      <StatStrip className={styles.readout} role="group" aria-label="Desktop session">
        <StatTile
          label="Link"
          value={link.value}
          tone={link.tone}
          /* The ring only travels while the link is still settling. A "Live"
             desktop that pulses forever is a light that never stops blinking. */
          icon={
            <span
              className={`${styles.pulseDot}${
                frameReady ? "" : ` ${styles.pulseDotSeeking}`
              }`}
              aria-hidden="true"
            />
          }
          hint={frameReady ? "desktop is drawing" : "waiting for the first frame"}
        />
        <StatTile
          label="Target"
          value={target}
          hint={workHost === "ssh" ? "remote SSH work host" : "local work host"}
        />
        <StatTile
          label="Desktop"
          value={desktopState.value}
          tone={desktopState.tone}
          hint={desktopState.hint}
        />
        <StatTile
          label="Frame"
          value={
            frameSize ? `${frameSize.width}×${frameSize.height}` : "—"
          }
          hint={frameSize ? `device pixel ratio ${frameSize.dpr}` : "measuring the canvas"}
        />
      </StatStrip>

      {/* The iframe is blank until the desktop's own page loads, which is
          several seconds on a cold workspace host. The hint sits above the
          frame, never over it. */}
      {!frameReady && (
        <p className={styles.frameHint} role="status">
          <span
            className={`${styles.pulseDot} ${styles.pulseDotSeeking}`}
            aria-hidden="true"
          />
          Opening the desktop…
        </p>
      )}
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
      </div>
    </PageShell>
  );
}
