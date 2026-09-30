"use client";

import React, { useState, useCallback, useEffect } from "react";
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
  flex: "0 0 auto",
  padding: "5px 14px",
  border: "1px solid",
  borderColor: active ? "rgba(255,255,255,0.16)" : "transparent",
  borderRadius: 6,
  background: active ? "rgba(142,53,255,0.18)" : "rgba(255,255,255,0.03)",
  color: active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.55)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
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
  // browser (ToolCallBlock broadcasts browser tool activity).
  useEffect(() => {
    const open = () => setActivePanel("browser");
    window.addEventListener("browser-agent-active", open);
    return () => window.removeEventListener("browser-agent-active", open);
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
      {/* Entry tab at the top of the screen while no panel is open; once a
          panel is open the tabs live on the panel's own header instead */}
      {!activePanel && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 8px",
            flexShrink: 0,
          }}
        >
          {RAIL_TABS.filter((tab) => tab.key === "browser").map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActivePanel("browser")}
              title="Show browser agent view"
              style={railTabStyle(false)}
            >
              <TbWorldWww size={14} />
              {tab.label}
            </button>
          ))}
        </div>
      )}

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
                backgroundColor: isDragging ? "#8e35ff" : "rgba(255, 255, 255, 0.06)",
                transition: isDragging ? "none" : "background-color 0.15s ease",
                flexShrink: 0,
                zIndex: 10,
              }}
              onMouseEnter={(e) => { if (!isDragging) e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.12)"; }}
              onMouseLeave={(e) => { if (!isDragging) e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.06)"; }}
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
              {/* Panel header sits on the panel's own top strip */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "5px 8px",
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.02)",
                  flexShrink: 0,
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
                      {tab.label}
                    </button>
                  );
                })}
              </div>
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
      </div>
    </div>
  );
};

export default SessionMainPage;
