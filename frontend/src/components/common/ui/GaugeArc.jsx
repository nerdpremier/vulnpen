import CountUp from "./CountUp";
import styles from "./graphics.module.scss";

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

/**
 * A single score against its ceiling: risk, confidence, a CVSS base score.
 *
 * Half a dial, flat edge down - the number sits where the dial opens, so the
 * arc and the value are read in one look. The fill is a stroke-dashoffset on a
 * semicircle path, which means no trigonometry in the render and a CSS
 * transition for free when the score moves.
 *
 * @param value    current score (0..max)
 * @param display  override the printed value (e.g. "7.4" vs 7.4)
 */
const GaugeArc = ({
  value = 0,
  max = 10,
  size = 190,
  thickness = 10,
  tone = "accent",
  label,
  display,
  className = "",
}) => {
  const safeMax = Number(max) > 0 ? Number(max) : 1;
  const numeric = Number(value);
  const ratio = Number.isFinite(numeric) ? clamp(numeric / safeMax, 0, 1) : 0;

  const radius = (size - thickness) / 2;
  const center = size / 2;
  const arcLength = Math.PI * radius;
  const path = `M ${thickness / 2} ${center} A ${radius} ${radius} 0 0 1 ${
    size - thickness / 2
  } ${center}`;

  return (
    <div
      className={[
        styles.gauge,
        styles[`tone_${tone}`] ?? "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size }}
      role="img"
      aria-label={`${label ? `${label}: ` : ""}${display ?? value} of ${safeMax}`}
    >
      <svg
        width={size}
        height={center + thickness / 2}
        viewBox={`0 0 ${size} ${center + thickness / 2}`}
        aria-hidden="true"
      >
        <path
          className={styles.gaugeTrack}
          d={path}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        <path
          className={styles.gaugeValue}
          d={path}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={arcLength}
          strokeDashoffset={arcLength * (1 - ratio)}
        />
      </svg>

      <div className={styles.gaugeCenter}>
        <span className={styles.gaugeValueText}>
          {display ??
            (Number.isFinite(numeric) ? (
              <CountUp end={numeric} decimals={safeMax <= 10 ? 1 : 0} />
            ) : (
              "–"
            ))}
        </span>
        {label && <span className={styles.gaugeLabel}>{label}</span>}
      </div>
    </div>
  );
};

export default GaugeArc;
