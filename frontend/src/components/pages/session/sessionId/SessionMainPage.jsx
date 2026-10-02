"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import { TbWorldWww } from "react-icons/tb";
import ChatView from "./ChatView";
import BrowserAgentPanel from "@/components/session/BrowserAgentPanel";
import BurpProxyPage from "@/components/pages/session/burp/BurpProxyPage";

// Tabs shown at the top of the screen. "browser" is always present;
// "burp" only appears once a panel is open, next to it.
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
  // The rail starts as a single BROWSER AGENT strip; clicking it opens the
  // panel and the rail expands to show the BURP tab next to it. Clicking the
  // active tab again closes the panel back to the single strip.
  const [activePanel, setActivePanel] = useState(null);

  // Unfold the live browser view whenever the agent starts driving the
  // browser (ToolCallBlock broadcasts browser tool activity), and fold it
  // back to the rail when that call finishes — unless the user opened it
  // themselves (manualOpenRef keeps their choice).
  const manualOpenRef = useRef(false);
  useEffect(() => {
    const open = () => {
      manualOpenRef.current = true;
      setActivePanel("browser");
    };
    const close = () => {
      if (manualOpenRef.current) {
        manualOpenRef.current = false;
        return;
      }
      setActivePanel((prev) => (prev === "browser" ? null : prev));
    };
    window.addEventListener("browser-agent-active", open);
    window.addEventListener("browser-agent-idle", close);
    return () => {
      window.removeEventListener("browser-agent-active", open);
      window.removeEventListener("browser-agent-idle", close);
    };
  }, []);

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

        {/* Right strip: one column split into two halves â€”
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
                onClick={() => setActivePanel(active ? null : tab.key)}
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

