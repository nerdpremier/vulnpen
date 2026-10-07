"use client";

import { getBrowserAgentVNC, getMagnitudeConfig } from "@/services/user.service";
import {
  BrowserModelSelector,
  BrowserReasoningSelector,
} from "@/components/agent/ModelSelector";
import { Spin, Result, Button, Typography } from "antd";
import { GlobalOutlined, SettingOutlined, DesktopOutlined, ReloadOutlined } from "@ant-design/icons";
import { useMemo } from "react";
import { useQuery } from "react-query";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URI || "http://localhost:8080";

const { Text } = Typography;

/**
 * Live noVNC view of the Magnitude browser agent, rendered as a side panel
 * next to the orchestrator chat. Chromium stays open between runs, so this
 * panel always reflects the browser's latest state.
 */
const BrowserAgentPanel = () => {
  const { data: magnitudeConfig, isLoading: configLoading } = useQuery(
    "magnitude-config",
    getMagnitudeConfig,
    { staleTime: 30000 }
  );

  const {
    data: vncData,
    isLoading: vncLoading,
    isError: vncError,
    refetch: refetchVnc,
  } = useQuery(
    "browser-agent-vnc",
    getBrowserAgentVNC,
    {
      enabled: !!magnitudeConfig?.enabled,
      staleTime: 30000,
      // The container's watchdog restarts a dead VNC stack on its own, so poll
      // while it is down and let the view recover without a manual reload.
      refetchInterval: (data) =>
        data?.mode === "docker" && data?.available && !data?.vncRunning
          ? 3000
          : false,
    }
  );

  const novncUrl = useMemo(() => {
    if (!vncData?.novncPort) return null;
    try {
      const backendOrigin = new URL(BACKEND_URL);
      return `${backendOrigin.protocol}//${backendOrigin.hostname}:${vncData.novncPort}`;
    } catch {
      return `http://localhost:${vncData.novncPort}`;
    }
  }, [vncData]);

  const panelStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: "1.5rem",
    textAlign: "center",
    gap: "0.75rem",
    background: "var(--cli-bg, transparent)",
  };

  if (configLoading || vncLoading) {
    return (
      <div style={panelStyle}>
        <Spin size="large" />
        <Text type="secondary" style={{ fontSize: "0.8rem" }}>
          Loading Browser Agent...
        </Text>
      </div>
    );
  }

  if (!magnitudeConfig?.enabled) {
    return (
      <div style={panelStyle}>
        <Result
          icon={<GlobalOutlined style={{ color: "var(--moon-accent)" }} />}
          title="Browser Agent Not Enabled"
          subTitle="Enable the Magnitude browser agent in Settings to see the live browser view here."
          extra={
            <Button
              type="primary"
              icon={<SettingOutlined />}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("open-settings", { detail: { tab: "magnitude" } })
                )
              }
              style={{
                background: "var(--moon-accent)",
                borderColor: "var(--moon-accent)",
              }}
            >
              Open Browser Agent Settings
            </Button>
          }
        />
      </div>
    );
  }

  if (vncError) {
    /* Without this the panel diagnoses "Headed Mode Not Active" whenever the
       API is unreachable, and sends the operator into Settings to change a
       setting that was never the problem. */
    return (
      <div style={panelStyle}>
        <Result
          icon={<ReloadOutlined style={{ color: "var(--moon-warning)" }} />}
          title="Could not read the browser agent's state"
          subTitle="The API did not answer, so this panel cannot tell whether the live browser view is available. Nothing has been changed."
          extra={
            <Button icon={<ReloadOutlined />} onClick={() => refetchVnc()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!vncData?.available) {
    return (
      <div style={panelStyle}>
        <Result
          icon={<GlobalOutlined style={{ color: "var(--moon-accent)" }} />}
          title="Headed Mode Not Active"
          subTitle="The browser agent is running in headless mode. Disable headless mode in Settings to see the live browser view."
          extra={
            <Button
              type="primary"
              icon={<SettingOutlined />}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("open-settings", { detail: { tab: "magnitude" } })
                )
              }
              style={{
                background: "var(--moon-accent)",
                borderColor: "var(--moon-accent)",
              }}
            >
              Open Browser Agent Settings
            </Button>
          }
        />
      </div>
    );
  }

  if (vncData?.mode === "dev") {
    return (
      <div style={panelStyle}>
        <Result
          icon={<DesktopOutlined style={{ color: "var(--moon-accent)" }} />}
          title="Developer Mode"
          subTitle={
            <span>
              The backend is running outside Docker, so the live VNC stream is
              unavailable — Chromium opens directly on the host desktop
              (display <code>{vncData.display}</code>).
            </span>
          }
          extra={
            <Button
              type="primary"
              icon={<SettingOutlined />}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("open-settings", { detail: { tab: "magnitude" } })
                )
              }
              style={{
                background: "var(--moon-accent)",
                borderColor: "var(--moon-accent)",
              }}
            >
              Open Browser Agent Settings
            </Button>
          }
        />
      </div>
    );
  }

  // Headed mode is configured, but the VNC stack in the container is not
  // serving. The watchdog restarts it automatically; keep polling via
  // refetchInterval above and offer a manual retry.
  if (!vncData?.vncRunning) {
    return (
      <div style={panelStyle}>
        <Result
          status="warning"
          title="Live Browser View Unavailable"
          subTitle={
            <span>
              The backend&apos;s VNC stack is not serving on display{" "}
              <code>{vncData?.display}</code>
              {vncData?.novncUp && !vncData?.rfbUp
                ? " — noVNC is up but the VNC server behind it is down."
                : " — the stream is starting or has stopped."}
              <br />
              <br />
              It restarts automatically; this panel reconnects on its own.
            </span>
          }
          extra={
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => refetchVnc()}
              style={{
                background: "var(--moon-accent)",
                borderColor: "var(--moon-accent)",
              }}
            >
              Retry Now
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "0.5rem",
          padding: "0.35rem 0.6rem",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          background: "var(--cli-bg, rgba(0, 0, 0, 0.35))",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "0.72rem", opacity: 0.6 }}>Browser model</span>
        <BrowserModelSelector />
        <BrowserReasoningSelector />
      </div>
      <iframe
        id="browser-agent-vnc-panel"
        src={`${novncUrl}/vnc.html?autoconnect=true&resize=scale`}
        width="100%"
        height="100%"
        frameBorder="0"
        allow="fullscreen"
        style={{ flex: 1, minHeight: 0, display: "block", background: "#000" }}
      >
        Browser not compatible.
      </iframe>
    </div>
  );
};

export default BrowserAgentPanel;
