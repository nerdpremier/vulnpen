import styles from "./Loader.module.scss";

/**
 * Blocking wait state: a slim indeterminate bar plus the message. Deliberately
 * graphic-free so it can sit inside any surface without adding decoration.
 */
const Loader = ({ message = "Loading", subtext }) => {
  return (
    <div className={styles.wrapper} role="status" aria-live="polite">
      <span className={styles.track} aria-hidden="true">
        <span className={styles.fill} />
      </span>
      <p className={styles.message}>{message}</p>
      {subtext && <span className={styles.subtext}>{subtext}</span>}
    </div>
  );
};

export default Loader;
