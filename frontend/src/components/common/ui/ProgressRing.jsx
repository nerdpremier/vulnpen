import styles from "./ui.module.scss";

/**
 * Circular progress dial for coverage metrics (e.g. WSTG cases executed).
 * Colour follows the semantic tone so a stalled or failing plan is obvious at
 * a glance without reading the number.
 */
const ProgressRing = ({
  value = 0,
  total = 0,
  size = 92,
  thickness = 6,
  caption = "COVERAGE",
  tone = "accent",
  showPercent = false,
  className = "",
}) => {
  const safeTotal = total > 0 ? total : 0;
  const safeValue = Math.max(0, Math.min(value, safeTotal || 0));
  const ratio = safeTotal > 0 ? safeValue / safeTotal : 0;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);

  const valueClass = [
    styles.ringValue,
    tone === "warning" ? styles.ringValueWarn : "",
    tone === "danger" ? styles.ringValueDanger : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={[styles.ring, className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${caption}: ${safeValue} of ${safeTotal}`}
    >
      <svg className={styles.ringSvg} width={size} height={size} aria-hidden="true">
        <circle
          className={styles.ringTrack}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
        />
        <circle
          className={valueClass}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <div className={styles.ringContent}>
        <span className={styles.ringValueText}>
          {showPercent
            ? `${Math.round(ratio * 100)}%`
            : `${safeValue}/${safeTotal}`}
        </span>
        <span className={styles.ringCaption}>{caption}</span>
      </div>
    </div>
  );
};

export default ProgressRing;
