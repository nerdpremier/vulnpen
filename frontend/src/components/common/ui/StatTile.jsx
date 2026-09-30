import styles from "./ui.module.scss";
import CountUp from "./CountUp";

const TONES = {
  neutral: "",
  success: styles.statTileSuccess,
  warning: styles.statTileWarning,
  danger: styles.statTileDanger,
  accent: styles.statTileAccent,
};

/**
 * Compact metric tile for page headers and filter rails.
 * Renders as a button when `onClick` is supplied so it can double as a filter.
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
      </span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </Tag>
  );
};

export default StatTile;
