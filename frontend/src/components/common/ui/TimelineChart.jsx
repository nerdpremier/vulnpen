import styles from "./graphics.module.scss";

/**
 * When things happened, on one shared axis: the runs of an engagement, the
 * phases of a single run, the window a window was scanned in.
 *
 * Every row is a labelled track and the span is a bar positioned in
 * percentages, so the whole history fits one viewport no matter how long the
 * engagement ran - and the gaps are as legible as the bars.
 *
 * @param items       [{ key?, label, start, end, tone?, title? }] in ms epochs
 * @param startLabel  axis caption for the left edge
 * @param endLabel    axis caption for the right edge
 */
const TimelineChart = ({
  items = [],
  startLabel,
  endLabel,
  className = "",
}) => {
  const rows = (Array.isArray(items) ? items : []).filter(
    (item) => Number.isFinite(item.start) && Number.isFinite(item.end)
  );

  if (!rows.length) return null;

  const start = Math.min(...rows.map((row) => row.start));
  const end = Math.max(...rows.map((row) => row.end));
  const span = end - start || 1;

  return (
    <div
      className={[styles.timeline, className].filter(Boolean).join(" ")}
      role="list"
    >
      {rows.map((row, index) => {
        const left = ((row.start - start) / span) * 100;
        const width = Math.max(((row.end - row.start) / span) * 100, 0.8);

        return (
          <div
            key={row.key ?? `${row.label}-${index}`}
            className={styles.timelineRow}
            role="listitem"
          >
            <span className={styles.timelineLabel}>{row.label}</span>
            <span className={styles.timelineTrack}>
              <span
                className={[
                  styles.timelineBar,
                  styles[`tone_${row.tone ?? "accent"}`] ?? "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ "--bar-x": `${left}%`, "--bar-w": `${width}%` }}
                title={row.title}
              />
            </span>
          </div>
        );
      })}

      {(startLabel || endLabel) && (
        <div className={styles.timelineAxis} aria-hidden="true">
          <span />
          <span className={styles.timelineAxisTrack}>
            <span>{startLabel}</span>
            <span>{endLabel}</span>
          </span>
        </div>
      )}
    </div>
  );
};

export default TimelineChart;
