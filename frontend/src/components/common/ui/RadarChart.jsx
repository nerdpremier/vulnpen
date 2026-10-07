import styles from "./graphics.module.scss";

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

/**
 * Coverage across ordered categories on one shape - the WSTG chapters a plan
 * covers, the pillars of a security posture.
 *
 * Ten bars would be ten separate readings; a radar shows the *outline* of the
 * coverage, which is what "where are we thin?" actually asks. Each axis prints
 * its own value under the label, so no tooltip is required.
 *
 * @param axes    [{ key?, label, value, max }]
 * @param levels  grid rings to draw, outermost = max
 */
const RadarChart = ({
  axes = [],
  size = 260,
  levels = 4,
  label,
  className = "",
}) => {
  const rows = Array.isArray(axes) ? axes : [];
  const count = rows.length;
  const padding = 38;
  const radius = size / 2 - padding;
  const center = size / 2;

  const angleAt = (index) =>
    -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);

  const pointAt = (index, distance) => [
    center + Math.cos(angleAt(index)) * distance,
    center + Math.sin(angleAt(index)) * distance,
  ];

  const ratioOf = (axis) => {
    const max = Number(axis.max) || 0;
    return max > 0 ? clamp((Number(axis.value) || 0) / max, 0, 1) : 0;
  };

  const ring = (fraction) =>
    rows
      .map((_, index) =>
        pointAt(index, radius * fraction)
          .map((n) => n.toFixed(1))
          .join(",")
      )
      .join(" ");

  const shape = rows
    .map((axis, index) =>
      pointAt(index, radius * ratioOf(axis))
        .map((n) => n.toFixed(1))
        .join(",")
    )
    .join(" ");

  if (!count) return null;

  return (
    <svg
      className={[styles.radar, className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={
        label ??
        rows
          .map((axis) => `${axis.label} ${axis.value} of ${axis.max}`)
          .join(", ")
      }
    >
      {Array.from({ length: levels }).map((_, index) => (
        <polygon
          key={`ring-${index}`}
          className={styles.radarGrid}
          points={ring((index + 1) / levels)}
        />
      ))}

      {rows.map((axis, index) => {
        const [x, y] = pointAt(index, radius);
        return (
          <line
            key={axis.key ?? axis.label}
            className={styles.radarSpoke}
            x1={center}
            y1={center}
            x2={x.toFixed(1)}
            y2={y.toFixed(1)}
          />
        );
      })}

      <polygon className={styles.radarShape} points={shape} />

      {rows.map((axis, index) => {
        const [x, y] = pointAt(index, radius * ratioOf(axis));
        return (
          <circle
            key={`vertex-${axis.key ?? axis.label}`}
            className={styles.radarVertex}
            cx={x.toFixed(1)}
            cy={y.toFixed(1)}
            r={2.4}
          />
        );
      })}

      {rows.map((axis, index) => {
        const [x, y] = pointAt(index, radius + 13);
        const cos = Math.cos(angleAt(index));
        const anchor = cos > 0.35 ? "start" : cos < -0.35 ? "end" : "middle";

        return (
          <text
            key={`label-${axis.key ?? axis.label}`}
            className={styles.radarLabel}
            x={x.toFixed(1)}
            y={y.toFixed(1)}
            textAnchor={anchor}
            dominantBaseline="middle"
          >
            {axis.label}
            <tspan
              className={styles.radarLabelValue}
              x={x.toFixed(1)}
              dy="0.92em"
            >
              {axis.value}/{axis.max}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
};

export default RadarChart;
