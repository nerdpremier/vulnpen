import React, { useMemo } from "react";
import { App, Popover, Tooltip } from "antd";
import { MdOutlineDeleteSweep } from "react-icons/md";
import { useQueryClient } from "react-query";
import { clearContext } from "@/services/agent.service";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { useAgentStreamStore } from "@/store/agentStream.store";
import styles from "@/styles/components/Chat.module.scss";

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Compact context-usage gauge for the chat status bar: a small ring showing
 * the % of the context window used. Clicking it opens a popover with the
 * token breakdown (tokens / limit / remaining / depth / last turn).
 */
export default function ContextUsageIndicator({ sessionId }) {
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const queryClient = useQueryClient();
  const tokenUsage = useAgentStreamStore(
    (state) => state.sessions[sessionId]?.tokenUsage ?? null,
  );
  const {
    totalTokens = 0,
    contextLimit = 128_000,
    promptTokens,
    completionTokens,
    iteration,
    maxIterations,
  } = tokenUsage || {};

  // True usage vs model limit (can exceed 100% — do not cap for the label)
  const usagePct = useMemo(() => {
    if (!contextLimit || contextLimit <= 0) return 0;
    return (totalTokens / contextLimit) * 100;
  }, [totalTokens, contextLimit]);

  // Ring fill caps at full circle when at or over limit
  const ringFillPct = Math.min(usagePct, 100);

  const remainingRaw = contextLimit - totalTokens;

  const radius = 7;
  const stroke = 2;
  const size = (radius + stroke) * 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (ringFillPct / 100) * circumference;

  const ringColor =
    usagePct >= 100
      ? "#ff4d4f"
      : usagePct >= 85
        ? "#ff7875"
        : usagePct >= 60
          ? "#faad14"
          : "#4a9eff";

  const details = (
    <div className={styles.contextDetailsPanel}>
      <div className={styles.contextRow}>
        <span>Tokens</span>
        <span>{totalTokens.toLocaleString()}</span>
      </div>
      <div className={styles.contextRow}>
        <span>Limit</span>
        <span>{formatTokenCount(contextLimit)}</span>
      </div>
      <div className={styles.contextRow}>
        <Tooltip
          title={
            remainingRaw >= 0
              ? "When the context limit is approached, VulnPen will automatically summarise the conversation to free up space. Your session will continue uninterrupted."
              : "Total tokens exceed the model context window until summarization runs. The percentage above reflects actual usage (can go above 100%)."
          }
        >
          <span className={styles.contextRowWithHelp}>
            {remainingRaw >= 0 ? "Remaining" : "Over limit by"} <i>?</i>
          </span>
        </Tooltip>
        <span>
          {remainingRaw >= 0
            ? formatTokenCount(remainingRaw)
            : formatTokenCount(totalTokens - contextLimit)}
        </span>
      </div>
      {iteration != null && maxIterations != null && (
        <div className={styles.contextRow}>
          <span>Depth</span>
          <span>
            {iteration} / {maxIterations}
          </span>
        </div>
      )}
      {promptTokens != null && (
        <>
          <div className={styles.contextRow}>
            <span>Last prompt</span>
            <span>{promptTokens.toLocaleString()}</span>
          </div>
          <div className={styles.contextRow}>
            <span>Last completion</span>
            <span>{(completionTokens ?? 0).toLocaleString()}</span>
          </div>
        </>
      )}
    </div>
  );

  const handleClearContext = () => {
    confirmPopUp({
      title: "Clear context?",
      content:
        "This will erase all conversation history for this session. The system prompt and shells will be preserved.",
      okText: "Clear",
      cancelText: "Cancel",
      async onOk() {
        try {
          await clearContext({ sessionId });
          message.success("Context cleared");
          window.dispatchEvent(
            new CustomEvent("context-cleared", { detail: { sessionId } }),
          );
          queryClient.invalidateQueries(["session-info", sessionId]);
        } catch {
          message.error("Failed to clear context");
        }
      },
    });
  };

  return (
    <Popover
      trigger="click"
      placement="topRight"
      content={
        <>
          {details}
          <div className={styles.contextClearRow}>
            <button
              type="button"
              className={styles.contextClearBtn}
              onClick={handleClearContext}
            >
              <MdOutlineDeleteSweep size={14} />
              Clear context
            </button>
          </div>
        </>
      }
      title="Context usage"
    >
      <button
        type="button"
        className={styles.contextBubble}
        aria-label={`Context used ${Math.round(usagePct)}%`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.3s ease" }}
          />
        </svg>
      </button>
    </Popover>
  );
}
