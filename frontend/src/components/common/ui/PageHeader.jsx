import React from "react";
import styles from "@/styles/components/Page.module.scss";

/**
 * The heading block of a page: a back affordance when the page was opened from
 * somewhere else, the eyebrow, title, description and metadata chips, with the
 * page's primary actions alongside.
 *
 * Every screen uses this so the title always sits at the same height and the
 * action button never moves when a description wraps. The actions share the
 * heading's first line rather than sitting in their own bar above it: a bar
 * with nothing in it but right-aligned buttons is a band of empty pixels at
 * the top of every page, which is exactly where the eye lands first.
 *
 * @param back     node — a back link or button
 * @param eyebrow  short uppercase label, e.g. "WSTG-INFO-02"
 * @param title    node — the h1
 * @param meta     node — chips/tiles rendered under the description
 * @param compact  bool — one-line variant for pages whose body is an embedded
 *                 editor or canvas, where header pixels come out of the tool
 */
const PageHeader = ({
  back,
  eyebrow,
  title,
  description,
  meta,
  actions,
  className = "",
  compact = false,
  children,
}) => {
  if (compact) {
    return (
      <header
        className={[styles.pageHeader, styles.pageHeaderCompact, className]
          .filter(Boolean)
          .join(" ")}
      >
        <div className={styles.pageHeaderBar}>
          {back && <div className={styles.pageBack}>{back}</div>}
          {eyebrow && <span className={styles.pageEyebrow}>{eyebrow}</span>}
          {title && <h1 className={styles.pageTitle}>{title}</h1>}
          {description && (
            <p className={styles.pageDescriptionCompact}>{description}</p>
          )}
          {actions && <div className={styles.pageActions}>{actions}</div>}
        </div>
        {meta && <div className={styles.pageMeta}>{meta}</div>}
        {children}
      </header>
    );
  }

  return (
    <header className={[styles.pageHeader, className].filter(Boolean).join(" ")}>
      <div className={styles.pageHeading}>
        {back && <div className={styles.pageBack}>{back}</div>}
        {eyebrow && <span className={styles.pageEyebrow}>{eyebrow}</span>}
        {title && <h1 className={styles.pageTitle}>{title}</h1>}
        {description && <p className={styles.pageDescription}>{description}</p>}
        {meta && <div className={styles.pageMeta}>{meta}</div>}
        {children}
      </div>

      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
};

export default PageHeader;

