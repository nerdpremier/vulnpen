"use client";

import React, { useEffect, useRef } from "react";
import ChatMessage from "../sessionId/ChatMessage";
import styles from "@/styles/pages/TestPlan.module.scss";

/**
 * The raw agent log of one scan — the same message rendering the chat uses
 * (Reasoning blocks, tool cards, OUTPUT), fed from the scan's transcript slice
 * instead of the session store. This is the engineering view, deliberately
 * behind the scan page's "Agent log" tab: the operator reads the results tab,
 * the log is there to explain them.
 */
export default function AgentLogStream({
  sessionId,
  visibleMessages,
  toolIndex,
  finished = false,
}) {
  const containerRef = useRef(null);
  const stickRef = useRef(true);

  // Stick to the bottom while the scan streams, like the chat does — but only
  // when the operator hasn't scrolled up to read something.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !stickRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [visibleMessages.length]);

  const onScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    stickRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  };

  return (
    <div className={styles.activityStream}>
      <div
        className={styles.activityMessages}
        ref={containerRef}
        onScroll={onScroll}
      >
        {!visibleMessages.length && (
          <p className={styles.activityEmpty}>
            {finished
              ? "No activity was recorded for this scan."
              : "Waiting for the agent to start this scan…"}
          </p>
        )}

        {visibleMessages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            toolIndex={toolIndex}
            sessionId={sessionId}
          />
        ))}
      </div>
    </div>
  );
}
