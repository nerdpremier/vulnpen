"use client";

import React, { useEffect, useRef } from "react";
import ChatMessage from "../sessionId/ChatMessage";
import ConsentBanner from "../sessionId/ConsentBanner";
import stylesRun from "@/styles/pages/TestPlan.module.scss";

/**
 * The live/replay activity feed of one run — the same message rendering the
 * chat uses (Reasoning blocks, tool cards, OUTPUT), fed from the run's
 * transcript slice instead of the session store. When the detached run parks
 * on a consent request, approve/deny right here.
 */
export default function RunActivityStream({
  sessionId,
  visibleMessages,
  toolIndex,
  pendingConsent,
  onConsent,
  finished = false,
}) {
  const containerRef = useRef(null);
  const stickRef = useRef(true);

  // Stick to the bottom while the run streams, like the chat does — but only
  // when the operator hasn't scrolled up to read something.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !stickRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [visibleMessages.length, pendingConsent != null]);

  const onScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    stickRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  };

  return (
    <div className={stylesRun.activityStream}>
      <div
        className={stylesRun.activityMessages}
        ref={containerRef}
        onScroll={onScroll}
      >
        {!visibleMessages.length && (
          <p className={stylesRun.activityEmpty}>
            {finished
              ? "No activity was recorded for this run."
              : "Waiting for the agent to start this run…"}
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

        {pendingConsent && (
          <ConsentBanner
            pendingConsent={pendingConsent}
            onApprove={() => onConsent?.(true)}
            onDeny={() => onConsent?.(false)}
          />
        )}
      </div>
    </div>
  );
}
