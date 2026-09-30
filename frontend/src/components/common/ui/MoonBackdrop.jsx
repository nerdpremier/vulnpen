import styles from "./ui.module.scss";

/**
 * Decorative canvas layer (xAI posture: flat near-black, no atmosphere).
 * Purely presentational: aria-hidden and pointer-events: none, so it can sit
 * behind any page or hero block. Optionally draws a faint hairline grid.
 *
 * @param {"page"|"hero"} variant  `page` pins the layer to the viewport, `hero`
 *                                 fills the nearest positioned ancestor.
 */
const MoonBackdrop = ({ variant = "hero", grid = true, className = "" }) => {
  const root = [
    styles.backdrop,
    variant === "page" ? styles.backdropPage : styles.backdropHero,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={root} aria-hidden="true">
      {grid && <span className={styles.grid} />}
    </div>
  );
};

export default MoonBackdrop;
