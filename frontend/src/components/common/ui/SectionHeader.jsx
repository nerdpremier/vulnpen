import styles from "./ui.module.scss";

/**
 * Page/section heading block: eyebrow, title, supporting copy and actions.
 * One implementation so every screen shares the same rhythm and alignment.
 */
const SectionHeader = ({
  eyebrow,
  title,
  description,
  actions,
  icon,
  className = "",
  id,
}) => (
  <div className={[styles.sectionHeader, className].filter(Boolean).join(" ")}>
    <div className={styles.sectionHeading}>
      {eyebrow && <span className={styles.sectionEyebrow}>{eyebrow}</span>}
      <h2 className={styles.sectionTitle} id={id}>
        {icon}
        {title}
      </h2>
      {description && (
        <p className={styles.sectionDescription}>{description}</p>
      )}
    </div>
    {actions && <div className={styles.sectionActions}>{actions}</div>}
  </div>
);

export default SectionHeader;
