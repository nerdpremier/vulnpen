"use client";

import React, { useState, useCallback, useEffect } from "react";
import { TbWorldWww } from "react-icons/tb";
import ChatView from "./ChatView";
import BrowserAgentPanel from "@/components/session/BrowserAgentPanel";

const SessionMainPage = ({ session_id }) => {
  const [panelWidth, setPanelWidth] = useState(45);
  const [isDragging, setIsDragging] = useState(false);
  // The live view starts collapsed; it unfolds itself when the agent starts
  // driving the browser (see the browser-agent-active listener below).
  const [panelOpen, setPanelOpen] = useState(false);

  // Unfold the live browser view whenever the agent starts driving the
  // browser (ToolCallBlock broadcasts browser tool activity).
  useEffect(() => {
    const open = () => setPanelOpen(true);
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

        {panelOpen ? (
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

            {/* Browser Agent Live View */}
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
              <button
                onClick={() => setPanelOpen(false)}
                title="Collapse browser view"
                style={{
                  position: "absolute",
                  top: 8,
                  left: 8,
                  zIndex: 20,
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(20,20,30,0.85)",
                  color: "rgba(255,255,255,0.7)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                »
              </button>
              <BrowserAgentPanel />
            </div>
          </>
        ) : (
          /* Collapsed strip */
          <button
            onClick={() => setPanelOpen(true)}
            title="Show browser agent view"
            style={{
              width: 34,
              alignSelf: "stretch",
              flexShrink: 0,
              border: "none",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
              color: "rgba(255,255,255,0.65)",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              paddingTop: 12,
              fontSize: 11,
              letterSpacing: "0.08em",
            }}
          >
            <TbWorldWww size={16} />
            <span style={{ writingMode: "vertical-rl" }}>BROWSER AGENT</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default SessionMainPage;
