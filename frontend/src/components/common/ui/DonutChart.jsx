import CountUp from "./CountUp";
import styles from "./graphics.module.scss";

/**
 * A part-of-whole split with the total in the hole.
 *
 * A pie is usually the wrong answer, but a donut on a metrics row earns its
 * place: the segments carry the proportions and the hole carries the number
 * they add up to, so the card needs no caption to say what it is counting.
 *
 * @param segments  [{ key?, label, value, tone? }] - tone defaults to the key
 * @param legend    "column" (default), "inline" or false
 */
const DonutChart = ({
  segments = [],
  size = 132,
  thickness = 14,
  centerValue,
  centerLabel,
  legend = "column",
  className = "",
}) => {
  const rows = (Array.isArray(segments) ? segments : []).filter(
    (segment) => Number(segment.value) > 0
  );
  const total = rows.reduce((sum, segment) => sum + Number(segment.value), 0);

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const radiusMid = size / 2;

  /* Prefix sums instead of a running accumulator: nothing is reassigned during
     render, so a re-render can never start from a half-advanced offset. */
  const arcs = rows.map((segment, index) => {
    const fraction = total > 0 ? Number(segment.value) / total : 0;
    const before =
      total > 0
        ? rows
            .slice(0, index)
            .reduce((sum, previous) => sum + Number(previous.value), 0) / total
        : 0;

    return { segment, fraction, before };
  });

  const ariaLabel = rows.length
    ? rows.map((segment) => `${segment.value} ${segment.label}`).join(", ")
    : "No data";

  return (
    <div
      className={[styles.donutWrap, className].filter(Boolean).join(" ")}
      role="img"
      aria-label={ariaLabel}
    >
      <div className={styles.donut} style={{ width: size, height: size }}>
        <svg
          className={styles.donutSvg}
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          aria-hidden="true"
        >
          <circle
            className={styles.donutTrack}
            cx={radiusMid}
            cy={radiusMid}
            r={radius}
            fill="none"
            strokeWidth={thickness}
          />
          {arcs.map(({ segment, fraction, before }) => {
            const dash = Math.max(fraction * circumference - 2, 0.6);

            return (
              <circle
                key={segment.key ?? segment.label}
                className={[
                  styles.donutSeg,
                  styles[`tone_${segment.tone ?? segment.key}`] ?? "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                cx={radiusMid}
                cy={radiusMid}
                r={radius}
                fill="none"
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-before * circumference}
                transform={`rotate(-90 ${radiusMid} ${radiusMid})`}
              />
            );
          })}
        </svg>

        <div className={styles.donutCenter}>
          <span className={styles.donutValue}>
            {typeof centerValue === "number" ? (
              <CountUp end={centerValue} />
            ) : (
              (centerValue ?? total)
            )}
          </span>
          {centerLabel && (
            <span className={styles.donutLabel}>{centerLabel}</span>
          )}
        </div>
      </div>

      {legend !== false && (
        <ul
          className={[
            styles.legend,
            legend === "inline" ? styles.legendInline : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {(Array.isArray(segments) ? segments : []).map((segment) => (
            <li
              key={segment.key ?? segment.label}
              className={[
                styles.legendItem,
                Number(segment.value) ? "" : styles.legendZero,
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span
                className={[
                  styles.legendSwatch,
                  styles[`tone_${segment.tone ?? segment.key}`] ?? "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              <span className={styles.legendLabel}>{segment.label}</span>
              <b>{segment.value}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default DonutChart;
