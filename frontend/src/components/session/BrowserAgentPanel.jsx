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
import { novncFrameSrc, resolveNovncBase } from "@/utils/novncView.mjs";
import { backendBaseURL } from "@/utils/axios.config";

const BACKEND_URL = backendBaseURL;

const { Text } = Typography;

/**
 * Live noVNC view of the Magnitude browser agent, rendered as a side panel
 * next to the orchestrator chat. Chromium stays open between runs, so this
 * panel always reflects the browser's latest state.
 *
 * Which screen it shows is decided by the API, not here. The agent's Chromium
 * runs on the attack box, whose desktop is a different VNC stack on a different
 * port from the backend's own; embedding a hard-coded `localhost:6080` showed
 * an empty display while the agent worked on the other machine. `novncUrl` is
 * that answer — with the password the desktop asks for — and the fallback below
 * only covers the local stack, which really does live on the backend's origin.
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

  const novncUrl = useMemo(
    () =>
      resolveNovncBase({
        novncUrl: vncData?.novncUrl,
        novncPort: vncData?.novncPort,
        backendUrl: BACKEND_URL,
      }),
    [vncData]
  );

  const frameSrc = useMemo(
    () => novncFrameSrc(novncUrl, vncData?.password),
    [novncUrl, vncData]
  );

  /* The two stacks are different machines, so every message that names one has
     to name the right one — the panel used to blame "the backend's VNC stack"
     for a stream that was never the backend's. */
  const onAttackBox = vncData?.workHost === "attack-box";
  const where = onAttackBox ? "The attack box's desktop" : "The backend's VNC stack";

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

  // Headed mode is configured, but the stack that draws the browser is not
  // serving. The watchdog restarts the backend's one automatically; the attack
  // box's is part of its image. Either way this panel keeps polling and offers
  // a manual retry.
  if (!vncData?.vncRunning) {
    return (
      <div style={panelStyle}>
        <Result
          status="warning"
          title="Live Browser View Unavailable"
          subTitle={
            <span>
              {where} is not serving on display <code>{vncData?.display}</code>
              {vncData?.novncUp && !vncData?.rfbUp
                ? " — noVNC is up but the VNC server behind it is down."
                : " — the stream is starting or has stopped."}
              {vncData?.note ? (
                <>
                  <br />
                  <br />
                  {vncData.note}
                </>
              ) : null}
              <br />
              <br />
              {onAttackBox
                ? "The desktop starts with the attack box; if it stays down, check that the box is running."
                : "It restarts automatically; this panel reconnects on its own."}
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

  /* Says which machine is on screen and whether the agent's browser is on it.
     Without it the operator cannot tell a desktop that is merely idle from one
     where the agent is working — the two look identical. */
  const statusLabel = vncData?.browserRunning
    ? "agent browser live"
    : "waiting for the browser";
  const statusColor = vncData?.browserRunning
    ? "var(--moon-success, #52c41a)"
    : "var(--moon-warning, #faad14)";
  const statusTitle = `${
    onAttackBox ? "Attack box desktop" : "Backend desktop"
  } · display ${vncData?.display}${
    vncData?.browserRunning
      ? " · the agent's Chromium is open here"
      : " · the agent's Chromium has not opened here yet"
  }`;

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
          justifyContent: "space-between",
          gap: "0.5rem",
          padding: "0.35rem 0.6rem",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          background: "var(--cli-bg, rgba(0, 0, 0, 0.35))",
          flexShrink: 0,
        }}
      >
        <span
          title={statusTitle}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            fontSize: "0.72rem",
            opacity: 0.75,
            whiteSpace: "nowrap",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "0.45rem",
              height: "0.45rem",
              borderRadius: "50%",
              background: statusColor,
              flexShrink: 0,
            }}
          />
          {statusLabel}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            minWidth: 0,
          }}
        >
          <span style={{ fontSize: "0.72rem", opacity: 0.6 }}>Browser model</span>
          <BrowserModelSelector />
          <BrowserReasoningSelector />
        </span>
      </div>
      <iframe
        id="browser-agent-vnc-panel"
        /* The desktop asks for a password when one was set, exactly as the
           Desktop tab's frame does; without it noVNC stops at
           "Authentication required" and the panel looks broken. */
        src={frameSrc}
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
