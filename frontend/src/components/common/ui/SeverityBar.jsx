import styles from "./ui.module.scss";

/**
 * A findings list's severity distribution: one stacked bar and a one-line
 * legend.
 *
 * The same six numbers used to arrive as five bordered pills — "0 critical",
 * "7 high", … — a row of containers each holding a dot and a word. The bar
 * carries the proportion in the width of the card, and the legend underneath
 * stays a line of text instead of a row of boxes.
 *
 * @param levels       [{ key, label, count }] — canonical order, critical first
 * @param legend       bool — draw the counts line under the bar (default true)
 * @param segmentCounts bool — print each count inside its own segment
 */
const SeverityBar = ({
  levels = [],
  className = "",
  legend = true,
  segmentCounts = false,
}) => {
  const populated = levels.filter((level) => level.count > 0);

  return (
    <div className={[styles.severityBar, className].filter(Boolean).join(" ")}>
      <div
        className={styles.severityTrack}
        role="img"
        aria-label={`Findings by severity: ${levels
          .map((level) => `${level.count} ${level.label.toLowerCase()}`)
          .join(", ")}`}
      >
        {populated.length === 0 ? (
          <span className={styles.severityEmpty} />
        ) : (
          populated.map((level) => (
            <span
              key={level.key}
              className={`${styles.severitySeg} ${styles[`sev_${level.key}`] ?? ""}`}
              /* flex-grow is the count: the segments keep their proportions
                 however wide the card is, with no measurement pass. */
              style={{ flexGrow: level.count }}
              title={`${level.count} ${level.label.toLowerCase()}`}
            >
              {segmentCounts && level.count > 0 ? (
                <span className={styles.severitySegCount}>{level.count}</span>
              ) : null}
            </span>
          ))
        )}
      </div>

      {legend && (
        <div className={styles.severityLegend}>
          {levels.map((level) => (
            <span
              key={level.key}
              className={[
                styles.severityLegendItem,
                level.count ? styles[`sev_${level.key}`] ?? "" : styles.severityLegendZero,
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className={styles.severityLegendDot} aria-hidden="true" />
              <b>{level.count}</b>
              <span>{level.label.toLowerCase()}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default SeverityBar;
