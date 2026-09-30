import styles from "./ui.module.scss";

/**
 * Shared empty state: an illustrated moon ring, a plain-language explanation of
 * why the surface is empty and the next action to take. Never leave a blank
 * panel - every list in the app routes its zero state through here.
 */
const EmptyState = ({
  icon,
  title,
  description,
  actions,
  compact = false,
  className = "",
}) => (
  <div
    className={[styles.emptyState, compact ? styles.emptyCompact : "", className]
      .filter(Boolean)
      .join(" ")}
    role="status"
  >
    <span className={styles.emptyArt} aria-hidden="true">
      {icon}
    </span>
    {title && <p className={styles.emptyTitle}>{title}</p>}
    {description && <p className={styles.emptyDescription}>{description}</p>}
    {actions && <div className={styles.emptyActions}>{actions}</div>}
  </div>
);

export default EmptyState;
