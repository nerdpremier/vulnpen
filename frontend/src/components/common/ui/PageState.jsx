"use client";

import React from "react";
import { Button, Spin } from "antd";
import { ExclamationCircleOutlined } from "@ant-design/icons";
import EmptyState from "./EmptyState";
import styles from "@/styles/components/Page.module.scss";

/**
 * The one place a page says "loading", "nothing here" or "that failed".
 *
 * Every list and detail screen used to hand-roll these three: some rendered a
 * bare <Spin>, some an empty <div>, some a paragraph with no way out of the
 * failure. Routing them through one component means a failed request always
 * offers a retry and an empty surface always explains the next step.
 *
 * @param state     "loading" | "empty" | "error"
 * @param variant   loading only: "skeleton" rows (default) or a "spinner"
 * @param onRetry   error only: renders a Try again button
 */
const PageState = ({
  state = "empty",
  variant = "skeleton",
  rows = 4,
  icon,
  title,
  description,
  actions,
  onRetry,
  retryLabel = "Try again",
  compact = false,
  className = "",
}) => {
  if (state === "loading") {
    if (variant === "spinner") {
      return (
        <div
          className={[styles.stateCenter, className].filter(Boolean).join(" ")}
          role="status"
          aria-busy="true"
        >
          <Spin />
          <span className={styles.stateSrOnly}>Loading</span>
        </div>
      );
    }
    return (
      <div
        className={[styles.skeletonStack, className].filter(Boolean).join(" ")}
        role="status"
        aria-busy="true"
      >
        {Array.from({ length: rows }).map((_, index) => (
          <span
            key={index}
            className={styles.skeletonRow}
            style={{ "--row-delay": `${index * 70}ms` }}
          />
        ))}
        <span className={styles.stateSrOnly}>Loading</span>
      </div>
    );
  }

  if (state === "error") {
    return (
      <EmptyState
        className={className}
        compact={compact}
        icon={icon ?? <ExclamationCircleOutlined />}
        title={title ?? "Something went wrong"}
        description={description}
        actions={
          <>
            {onRetry && <Button onClick={onRetry}>{retryLabel}</Button>}
            {actions}
          </>
        }
      />
    );
  }

  return (
    <EmptyState
      className={className}
      compact={compact}
      icon={icon}
      title={title}
      description={description}
      actions={actions}
    />
  );
};

export default PageState;
