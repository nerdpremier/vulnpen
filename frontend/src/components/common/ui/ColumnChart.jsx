import styles from "./graphics.module.scss";

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

/**
 * Vertical bars for a distribution with a small number of categories: findings
 * per severity, cases per WSTG category, requests per host.
 *
 * Each column carries its own value in the band above the bar, so the height is
 * readable without a legend or a gridline. Pure CSS grid - no measuring, no
 * library - and the bar grows from `--bar-h`, which also anchors the label.
 *
 * @param data   [{ key?, label, value, display?, tone?, title? }]
 * @param height plot height in px, excluding the label row
 */
const ColumnChart = ({
  data = [],
  height = 96,
  showValues = true,
  label,
  className = "",
}) => {
  const rows = Array.isArray(data) ? data : [];
  const max = rows.length
    ? Math.max(...rows.map((row) => Number(row.value) || 0), 0)
    : 0;

  return (
    <div className={[styles.columnChart, className].filter(Boolean).join(" ")}>
      <div
        className={styles.columns}
        style={{ "--chart-h": `${height}px` }}
        role="img"
        aria-label={label}
      >
        {rows.map((row, index) => {
          const value = Number(row.value) || 0;
          const percent =
            max > 0 ? clamp((value / max) * 100, value > 0 ? 3 : 0, 100) : 0;

          return (
            <div
              key={row.key ?? `${row.label}-${index}`}
              className={styles.column}
              style={{ "--bar-h": `${percent}%` }}
              title={row.title ?? `${row.label}: ${value}`}
            >
              <span className={styles.columnTrack}>
                {showValues && (
                  <span className={styles.columnValue}>
                    {row.display ?? value}
                  </span>
                )}
                <span
                  className={[
                    styles.columnBar,
                    styles[`tone_${row.tone ?? "accent"}`] ?? "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.columnLabels} aria-hidden="true">
        {rows.map((row, index) => (
          <span
            key={row.key ?? `${row.label}-${index}`}
            className={styles.columnLabel}
          >
            {row.label}
          </span>
        ))}
      </div>
    </div>
  );
};

export default ColumnChart;
