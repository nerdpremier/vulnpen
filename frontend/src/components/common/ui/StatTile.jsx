import styles from "./ui.module.scss";
import graphics from "./graphics.module.scss";
import CountUp from "./CountUp";
import Sparkline from "./Sparkline";

const TONES = {
  neutral: "",
  success: styles.statTileSuccess,
  warning: styles.statTileWarning,
  danger: styles.statTileDanger,
  accent: styles.statTileAccent,
  info: styles.statTileInfo,
  critical: styles.statTileCritical,
  high: styles.statTileHigh,
  medium: styles.statTileMedium,
  low: styles.statTileLow,
};

const SPARK_TONES = {
  neutral: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  accent: "accent",
  info: "info",
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * Compact metric tile for page headers and filter rails.
 * Renders as a button when `onClick` is supplied so it can double as a filter.
 *
 * @param spark  a series to draw under the number - turns the tile from a
 *               snapshot into a trend without adding a sentence
 * @param trend  any node rendered beside the number (a delta chip, a unit)
 */
const StatTile = ({
  label,
  value,
  total,
  hint,
  icon,
  tone = "neutral",
  active = false,
  onClick,
  count = true,
  spark,
  trend,
  className = "",
}) => {
  const interactive = typeof onClick === "function";
  const Tag = interactive ? "button" : "div";

  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={onClick}
      aria-pressed={interactive ? active : undefined}
      className={[
        styles.statTile,
        interactive ? styles.statTileInteractive : "",
        active ? styles.statTileActive : "",
        TONES[tone] || "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.statLabel}>
        {icon && <span className={styles.statIcon}>{icon}</span>}
        {label}
      </span>
      <span className={styles.statValueRow}>
        <span className={styles.statValue}>
          {count && typeof value === "number" ? <CountUp end={value} /> : value}
        </span>
        {total != null && <span className={styles.statTotal}>/ {total}</span>}
        {trend}
      </span>
      {Array.isArray(spark) && spark.length > 1 && (
        <Sparkline
          className={graphics.statSpark}
          values={spark}
          tone={SPARK_TONES[tone] ?? "accent"}
          height={26}
          label={`${label} trend`}
        />
      )}
      {hint && <span className={styles.statHint}>{hint}</span>}
    </Tag>
  );
};

export default StatTile;
