import React, { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { Button, notification, Tooltip } from "antd";
import { DownOutlined, MessageOutlined, ReloadOutlined } from "@ant-design/icons";
import { FiActivity, FiCheckCircle, FiClock, FiXCircle } from "react-icons/fi";
import Image from "next/image";
import { useRouter } from "next/navigation";
import styles from "@/styles/components/Chat.module.scss";
import ChatMessage from "./ChatMessage";

import ChatInput from "./ChatInput";
import SlashCommandResult from "./SlashCommandResult";

import ConsentBanner from "./ConsentBanner";
import InstallSuggestionBanner from "./InstallSuggestionBanner";
import IterationLimitBanner from "./IterationLimitBanner";
import useAgentStream from "@/hooks/useAgentStream";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { pauseAgent } from "@/services/agent.service";
import { buildToolIndex } from "@/utils/toolIndex.mjs";
import { formatElapsed, summariseSessionActivity } from "@/utils/sessionActivity.mjs";
import { buildBurpMessage, takeBurpHandoff } from "@/utils/burpHandoff.mjs";
import { BarList, PageState, StatStrip, StatTile } from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
import { useQueryClient } from "react-query";

export default function ChatView({ sessionId }) {
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [installSuggestions, setInstallSuggestions] = useState([]);
  const [iterationLimit, setIterationLimit] = useState(null);
  const queryClient = useQueryClient();
  const router = useRouter();

  const FAR_UP_THRESHOLD = 250;

  const handleInstallSuggestion = useCallback((suggestion) => {
    setInstallSuggestions((prev) => {
      if (prev.some((s) => s.name === suggestion.name)) return prev;
      return [...prev, suggestion];
    });
  }, []);

  const dismissInstallSuggestion = useCallback((name) => {
    setInstallSuggestions((prev) => prev.filter((s) => s.name !== name));
  }, []);

  const handleAgentComplete = useCallback(() => {
    queryClient.invalidateQueries(["session-info", sessionId]);
  }, [queryClient, sessionId]);

  const handleIterationLimit = useCallback((data) => {
    setIterationLimit(data);
  }, []);

  const {
    messages,
    setMessages,
    agentState,
    setAgentState,
    pendingConsent,
    setPendingConsent,
    setTokenUsage,
    startStream,
    abort,
  } = useAgentStream({
    sessionId,
    onComplete: handleAgentComplete,
    onInstallSuggestion: handleInstallSuggestion,
    onIterationLimit: handleIterationLimit,
  });

  const scrollToBottom = useCallback((behavior = "auto") => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const updateStickToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldStickToBottomRef.current = distFromBottom < 150;
    setShowScrollBtn(distFromBottom > FAR_UP_THRESHOLD);
  }, []);

  const historyLoaded = useAgentStreamStore(
    (state) => state.sessions[sessionId]?.historyLoaded ?? false,
  );
  const historyError = useAgentStreamStore(
    (state) => state.sessions[sessionId]?.historyError ?? null,
  );
  const historyLoading = !historyLoaded && !historyError;

  useEffect(() => {
    if (historyLoaded) {
      shouldStickToBottomRef.current = true;
      // Loaded history resets the scroll affordance before repositioning.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowScrollBtn(false);
      setTimeout(() => scrollToBottom(), 50);
    }
  }, [historyLoaded, scrollToBottom]);

  const scrollRafRef = useRef(null);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    // Streaming updates land far faster than the browser paints, so coalesce
    // scroll writes into the next frame instead of one per update.
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      scrollToBottom();
    });
  }, [messages, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleContextCleared = (e) => {
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) return;
      setMessages([]);
      setAgentState("idle");
      setPendingConsent(null);
      setTokenUsage(null);
      setIterationLimit(null);
      abort();
    };
    window.addEventListener("context-cleared", handleContextCleared);
    return () => window.removeEventListener("context-cleared", handleContextCleared);
  }, [sessionId, setMessages, setAgentState, setPendingConsent, setTokenUsage, abort]);

  const [burpAttachment, setBurpAttachment] = useState(null);

  const handleSend = useCallback(
    (message) => {
      setIterationLimit(null);
      if (message.startsWith("/")) {
        setMessages((prev) => [
          ...prev,
          {
            id: uuidv4(),
            role: "user",
            content: message,
            isSlashCommand: true,
            timestamp: new Date(),
          },
        ]);
        startStream({ message, endpoint: "slash-command" });
        return;
      }

      let finalMessage = message;
      let burpMeta = null;
      if (burpAttachment) {
        const built = buildBurpMessage(message, burpAttachment);
        finalMessage = built.text;
        burpMeta = built.burpMeta;
        setBurpAttachment(null);
      }

      const endpoint =
        agentState === "paused" ? "resume" : "message";

      /**
       * Echo the turn immediately. The composer clears on send and the server
       * acknowledges only after it has persisted the message, so a slow round
       * trip used to leave the operator's own text out of the transcript — and
       * a failed request lost it entirely. The ack replaces this entry
       * (anything still marked `pending`) rather than appending beside it.
       */
      setMessages((prev) => [
        ...prev,
        {
          id: `pending-${uuidv4()}`,
          role: "user",
          content: finalMessage,
          timestamp: new Date(),
          pending: true,
          ...(burpMeta ? { burpMeta } : {}),
        },
      ]);

      startStream({ message: finalMessage, endpoint, burpMeta });
    },
    [agentState, startStream, setMessages, burpAttachment],
  );

  const handleContinueAfterLimit = useCallback(() => {
    setIterationLimit(null);
    startStream({ message: "", endpoint: "resume" });
  }, [startStream]);

  const handlePause = useCallback(async () => {
    try {
      await pauseAgent({ sessionId });
      abort(); // disconnects SSE, internally sets agentState("idle")
      setAgentState("paused"); // override to "paused" so resume flow works
    } catch (err) {
      notification.error({
        message: "Failed to pause",
        description: err?.response?.data?.message ?? "Something went wrong",
      });
      abort();
      setAgentState("paused");
    }
  }, [sessionId, abort, setAgentState]);

  const handleConsent = useCallback(
    (approved, toolCallIds) => {
      setPendingConsent(null);
      setAgentState("running");
      startStream({
        message: JSON.stringify({
          approved,
          // Only sent for per-item approval: the backend reads a missing list
          // as "the whole batch" and an empty one as "none of it".
          ...(Array.isArray(toolCallIds) ? { toolCallIds } : {}),
        }),
        endpoint: "consent",
      });
    },
    [setPendingConsent, setAgentState, startStream],
  );

  /**
   * A consent request must not be missable.
   *
   * The banner is the last child of the scrolling transcript, so an operator
   * reading back through a long log never saw it appear: the run parked and
   * the only signal was a disabled composer. Arriving consent now takes the
   * scroll to the bottom and restores the "latest" affordance.
   */
  useEffect(() => {
    if (!pendingConsent || agentState !== "waiting_consent") return;
    shouldStickToBottomRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowScrollBtn(false);
    // One frame later: the banner has to be in the DOM before we can reach it.
    const frame = requestAnimationFrame(() => scrollToBottom("smooth"));
    return () => cancelAnimationFrame(frame);
  }, [pendingConsent, agentState, scrollToBottom]);

  const burpPendingProcessed = useRef(false);
  useEffect(() => {
    if (historyLoading || burpPendingProcessed.current) return;
    // Consume the cross-page session-storage handoff once history is ready.
    const parsed = takeBurpHandoff();
    if (parsed) {
      burpPendingProcessed.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBurpAttachment(parsed);
    }
  }, [historyLoading]);

  // Tool calls and their results are indexed once per message-list change.
  // ChatMessage used to scan the whole list (twice per rendered message, on
  // every streaming frame), which made long sessions quadratic. The index also
  // lets tool results render inline inside their parent assistant block.
  // The builder is shared with the case page's run activity stream.
  const { toolIndex, visibleMessages } = useMemo(
    () => buildToolIndex(messages),
    [messages],
  );

  /**
   * What the agent actually did in this session. A transcript says what was
   * tried; this says how much of it landed, which tools carried the work and
   * how long the engagement has been running — the questions a tester asks
   * before reading a long log, answered without reading it.
   */
  const activity = useMemo(
    () => summariseSessionActivity(messages, toolIndex),
    [messages, toolIndex],
  );

  const isEmpty = messages.length === 0 && !historyLoading && !historyError;

  /* The chat's own controls, in the same header slot every session page uses:
     the live transcript reloads from the server, and the page's other primary
     action is to jump to the records the conversation is producing. */
  const actions = useMemo(
    () => (
      <>
        <Tooltip title="Reload the transcript">
          <Button
            icon={<ReloadOutlined />}
            onClick={() =>
              useAgentStreamStore.getState().retryHistory(sessionId)
            }
            aria-label="Reload the transcript"
          />
        </Tooltip>
        <Button
          icon={<MessageOutlined />}
          onClick={() => router.push(`/session/${sessionId}/vulnerabilities`)}
        >
          Findings
        </Button>
        <Button
          type="primary"
          onClick={() => {
            const el = messagesContainerRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          disabled={isEmpty}
        >
          Latest
        </Button>
      </>
    ),
    [sessionId, router, isEmpty],
  );
  usePublishHeaderActions(actions);

  return (
    <div className={styles.chatContainer}>
      <div
        className={styles.messagesArea}
        ref={messagesContainerRef}
        onScroll={updateStickToBottom}
      >
        {/* The session's readout, at the top of the transcript: it scrolls away
            with the conversation instead of costing the composer its room. */}
        {!isEmpty && activity.calls > 0 && (
          <section className={styles.activitySummary} aria-label="Session activity">
            <StatStrip className={styles.activityStrip}>
              <StatTile
                label="Tool calls"
                value={activity.calls}
                icon={<FiActivity />}
                hint={activity.running ? `${activity.running} running now` : "all settled"}
              />
              <StatTile
                label="Succeeded"
                value={activity.succeeded}
                tone="success"
                icon={<FiCheckCircle />}
              />
              <StatTile
                label="Failed"
                value={activity.failed}
                tone={activity.failed ? "danger" : "neutral"}
                icon={<FiXCircle />}
              />
              <StatTile
                label="Elapsed"
                value={formatElapsed(activity.elapsedMs)}
                count={false}
                icon={<FiClock />}
              />
            </StatStrip>

            {activity.tools.length > 1 && (
              <div className={styles.activityTools}>
                <h2 className={styles.activityTitle}>Tools carrying the work</h2>
                <BarList items={activity.tools} />
              </div>
            )}
          </section>
        )}
        {historyError && messages.length === 0 && (
          <PageState
            state="error"
            title="Could not load this transcript"
            description={`${historyError} The conversation with the agent is still on the server; load it again to continue.`}
            onRetry={() =>
              useAgentStreamStore.getState().retryHistory(sessionId)
            }
          />
        )}

        {historyLoading && (
          <PageState state="loading" rows={3} />
        )}

        {isEmpty && (
          <div className={styles.emptyState}>
            <Image
              src="/t-net-logo.png"
              alt="VulnPen"
              width={72}
              height={65}
              className={styles.emptyStateLogo}
            />
            <p>What do you want to secure today?</p>
          </div>
        )}

        {visibleMessages.map((msg) => {
          if (msg.role === "slash_command_result") {
            return <SlashCommandResult key={msg.id} message={msg} />;
          }
          return (
            <ChatMessage
              key={msg.id}
              message={msg}
              toolIndex={toolIndex}
              sessionId={sessionId}
            />
          );
        })}

        {pendingConsent && agentState === "waiting_consent" && (
          <ConsentBanner
            pendingConsent={pendingConsent}
            onApprove={(ids) => handleConsent(true, ids)}
            onDeny={() => handleConsent(false)}
          />
        )}

        {iterationLimit && (
          <IterationLimitBanner
            limit={iterationLimit.maxIterations}
            onContinue={handleContinueAfterLimit}
            onStop={() => setIterationLimit(null)}
          />
        )}

        {installSuggestions.map((suggestion) => (
          <InstallSuggestionBanner
            key={suggestion.name}
            suggestion={suggestion}
            sessionId={sessionId}
            onDismiss={() => dismissInstallSuggestion(suggestion.name)}
          />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {showScrollBtn && !isEmpty && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          title="Scroll to latest"
          className={styles.scrollToBottomBtn}
        >
          <DownOutlined />
          <span>scroll to latest</span>
        </button>
      )}

      <ChatInput
        sessionId={sessionId}
        onSend={handleSend}
        onPause={handlePause}
        agentState={agentState}
        disabled={historyLoading || agentState === "waiting_consent"}
        burpAttachment={burpAttachment}
        onDismissBurpAttachment={() => setBurpAttachment(null)}
      />
    </div>
  );
}
