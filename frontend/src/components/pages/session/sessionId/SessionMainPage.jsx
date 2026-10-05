"use client";

import React, { useState, useCallback, useEffect } from "react";
import { TbWorldWww } from "react-icons/tb";
import ChatView from "./ChatView";
import BrowserAgentPanel from "@/components/session/BrowserAgentPanel";
import BurpProxyPage from "@/components/pages/session/burp/BurpProxyPage";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { isBrowserAgentActive } from "@/utils/browserAgentActivity.mjs";

// The right rail: one strip split into two halves, BROWSER AGENT above and
// BURP below. Each half toggles its own panel.
const RAIL_TABS = [
  { key: "browser", label: "BROWSER AGENT" },
  { key: "burp", label: "BURP" },
];

const railTabStyle = (active) => ({
  flex: "1 1 0%",
  border: "none",
  borderTop: active ? "2px solid var(--moon-accent)" : "1px solid var(--moon-line-1)",
  background: active ? "var(--moon-accent-14)" : "var(--moon-surface-1)",
  color: active ? "var(--moon-text)" : "var(--moon-text-dim)",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  fontSize: 11,
  letterSpacing: "0.08em",
});

const SessionMainPage = ({ session_id }) => {
  const [panelWidth, setPanelWidth] = useState(45);
  const [isDragging, setIsDragging] = useState(false);
  // Clicking a rail tab opens that panel; clicking the active tab again
  // closes it. The two tabs are independent, so a BURP click never opens
  // the browser-agent view and vice versa.
  const [activePanel, setActivePanel] = useState(null);

  // Browser-agent activity is derived from the session's message list, not
  // from tool-block CustomEvents — the panel can never leak open.
  const sessionMessages = useAgentStreamStore(
    (s) => s.sessions[session_id]?.messages,
  );
  const browserActive = isBrowserAgentActive(sessionMessages);

  // Fold the live browser view back to the rail once the agent's browser
  // call finishes — unless the user opened the panel themselves (manualOpenRef
  // keeps their choice until the agent's next browser action supersedes it).
  // Derived-state adjustment during render (not an effect) — setState inside
  // an effect body cascades renders.
  const [manualOpenPanel, setManualOpenPanel] = useState(null);
  const openPanelManually = useCallback((key) => {
    setManualOpenPanel((prev) => (prev === key ? null : key));
    setActivePanel((prev) => (prev === key ? null : key));
  }, []);

  const [prevBrowserActive, setPrevBrowserActive] = useState(browserActive);
  if (browserActive !== prevBrowserActive) {
    setPrevBrowserActive(browserActive);
    if (browserActive) {
      // The agent opening the panel supersedes a previous manual open:
      // when its work finishes the panel must fold back automatically.
      setManualOpenPanel(null);
      setActivePanel("browser");
    } else if (manualOpenPanel === null) {
      setActivePanel((prev) => (prev === "browser" ? null : prev));
    } else {
      // The operator was looking at their own panel when the run ended;
      // theirs stays open, the agent's view folds away with the run.
      setManualOpenPanel(null);
    }
  }

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);

    const handleMouseMove = (e) => {
      const container = document.getElementById("session-split-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = ((rect.right - e.clientX) / rect.width) * 100;
      setPanelWidth(Math.max(20, Math.min(70, pct)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
      <div
        id="session-split-container"
        style={{
          display: "flex",
          flex: "1 1 0%",
          minHeight: 0,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Agent Chat Panel */}
        <div style={{
          flex: "1 1 0%",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}>
          <ChatView sessionId={session_id} />
        </div>

        {activePanel && (
          <>
            {/* Resize Handle */}
            <div
              onMouseDown={handleMouseDown}
              style={{
                width: 4,
                cursor: "col-resize",
                backgroundColor: isDragging ? "var(--moon-accent)" : "var(--moon-line-1)",
                transition: isDragging ? "none" : "background-color 0.15s ease",
                flexShrink: 0,
                zIndex: 10,
              }}
              onMouseEnter={(e) => { if (!isDragging) e.currentTarget.style.backgroundColor = "var(--moon-line-3)"; }}
              onMouseLeave={(e) => { if (!isDragging) e.currentTarget.style.backgroundColor = "var(--moon-line-1)"; }}
            />

            {/* Panel Content (Browser Agent / Burp) */}
            <div style={{
              width: `${panelWidth}%`,
              minWidth: 200,
              minHeight: 0,
              overflow: "hidden",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              position: "relative",
              // The noVNC iframe would swallow mousemove events while the
              // resize handle is dragged and strand the drag mid-way.
              pointerEvents: isDragging ? "none" : "auto",
            }}>
              {activePanel === "browser" ? (
                <BrowserAgentPanel />
              ) : (
                <div style={{ flex: "1 1 0%", minHeight: 0, overflow: "auto" }}>
                  <BurpProxyPage sessionId={session_id} />
                </div>
              )}
            </div>
          </>
        )}

        {/* Right strip: one column split into two halves -
            BROWSER AGENT on top, BURP below */}
        <div
          style={{
            width: 42,
            alignSelf: "stretch",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {RAIL_TABS.map((tab) => {
            const active = activePanel === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => openPanelManually(tab.key)}
                title={active ? "Close panel" : `Show ${tab.key === "burp" ? "Burp" : "browser agent"} view`}
                style={railTabStyle(active)}
              >
                {tab.key === "browser" && <TbWorldWww size={14} />}
                <span style={{ writingMode: "vertical-rl" }}>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default SessionMainPage;

