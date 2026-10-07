import styles from "./graphics.module.scss";

/**
 * Ranked horizontal bars - "top N" panels where there is not enough width for a
 * column per category (hosts, endpoints, techniques, models).
 *
 * The track is the axis: every row is scaled against the same `max`, so the
 * bars stay comparable while the labels keep their full name.
 *
 * @param items  [{ key?, label, value, tone?, hint? }]
 * @param max    override for the scale; defaults to the largest value
 * @param format (value) => string, for units
 */
const BarList = ({ items = [], max, format, className = "" }) => {
  const rows = Array.isArray(items) ? items : [];
  const highest =
    Number.isFinite(max) && max > 0
      ? max
      : rows.reduce((top, row) => Math.max(top, Number(row.value) || 0), 0);

  return (
    <div
      className={[styles.barList, className].filter(Boolean).join(" ")}
      role="list"
    >
      {rows.map((row, index) => {
        const value = Number(row.value) || 0;
        const percent = highest > 0 ? Math.min((value / highest) * 100, 100) : 0;

        return (
          <div
            key={row.key ?? `${row.label}-${index}`}
            className={styles.barRow}
            role="listitem"
            title={row.hint ?? `${row.label}: ${value}`}
          >
            <span className={styles.barLabel}>{row.label}</span>
            <span
              className={[
                styles.barTrack,
                styles[`tone_${row.tone ?? "accent"}`] ?? "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span
                className={styles.barFill}
                style={{ "--bar-w": `${percent}%` }}
              />
            </span>
            <span className={styles.barValue}>
              {format ? format(value) : value}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default BarList;
