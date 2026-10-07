"use client";

import React from "react";
import styles from "@/styles/components/Page.module.scss";

/**
 * The page frame every product screen renders inside.
 *
 * Before this existed each page borrowed another page's shell — the case page
 * took `.detailPage` from the vulnerabilities module, which is a flex column
 * with `overflow: hidden`, so long pages were clipped instead of scrolling.
 * Two rules now hold everywhere:
 *
 *   1. The shell owns the scrollbar, the reading measure and the responsive
 *      padding; a page only owns what is inside it.
 *   2. Nothing inside the shell shrinks: `min-height: 0` plus a scrolling
 *      container means content is never squeezed below its own height.
 *
 * @param width  "default" = the comfortable product measure,
 *               "full"    = edge to edge (tables, canvases, chat).
 */
const WIDTHS = {
  default: "",
  full: styles.pageInnerFull,
};

const PageShell = ({
  width = "default",
  as: Tag = "div",
  className = "",
  innerClassName = "",
  children,
  ...rest
}) => (
  <Tag
    className={[styles.pageShell, className].filter(Boolean).join(" ")}
    {...rest}
  >
    <div
      className={[styles.pageInner, WIDTHS[width], innerClassName]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  </Tag>
);

export default PageShell;
