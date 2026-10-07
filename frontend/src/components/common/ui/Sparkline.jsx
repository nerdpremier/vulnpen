import { useId } from "react";
import styles from "./graphics.module.scss";

/**
 * A trend line for a metric that already has history: scans per day, findings
 * discovered per run, coverage over time.
 *
 * The curve is stretched to the container with preserveAspectRatio="none" and
 * drawn with vector-effect="non-scaling-stroke", so the line keeps a 1.5px
 * weight at any width and nothing has to measure the DOM.
 *
 * @param values  the series, oldest first; non-finite entries are dropped
 * @param tone    palette key - "accent", "success", "danger", a severity, …
 * @param label   screen-reader summary of the series
 */
const Sparkline = ({
  values = [],
  tone = "accent",
  height = 44,
  area = true,
  label,
  className = "",
}) => {
  const gradientId = useId();
  const points = (Array.isArray(values) ? values : []).filter((value) =>
    Number.isFinite(value)
  );

  const width = 300;
  const top = 8;
  const bottom = 92;
  const max = points.length ? Math.max(...points) : 0;
  const min = points.length ? Math.min(...points) : 0;
  const span = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const coords = points.map((value, index) => [
    index * step,
    bottom - ((value - min) / span) * (bottom - top),
  ]);
  const line = coords
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const filled =
    area && first && last
      ? `M ${first[0].toFixed(1)},100 L ${line.split(" ").join(" L ")} L ${last[0].toFixed(1)},100 Z`
      : null;

  return (
    <span
      className={[styles.spark, styles[`tone_${tone}`] ?? "", className]
        .filter(Boolean)
        .join(" ")}
      style={{ "--spark-h": `${height}px` }}
    >
      {coords.length < 2 ? (
        <span className={styles.sparkEmpty} aria-hidden="true" />
      ) : (
        <svg
          className={styles.sparkSvg}
          viewBox={`0 0 ${width} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          {filled && (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={filled} fill={`url(#${gradientId})`} />
            </>
          )}
          <polyline
            className={styles.sparkLine}
            points={line}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </span>
  );
};

export default Sparkline;
