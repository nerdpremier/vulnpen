import styles from "./ui.module.scss";

/**
 * Decorative night sky (React Bits-style background layer, retuned as
 * monochrome moonlight). Purely presentational: aria-hidden and
 * pointer-events: none, so it can sit behind any page or hero block.
 *
 * @param {"page"|"hero"} variant  `page` pins the sky to the viewport, `hero`
 *                                 fills the nearest positioned ancestor.
 */
const MoonBackdrop = ({
  variant = "hero",
  grid = true,
  grain = true,
  vignette = true,
  className = "",
}) => {
  const root = [
    styles.backdrop,
    variant === "page" ? styles.backdropPage : styles.backdropHero,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={root} aria-hidden="true">
      <span className={styles.halo} />
      <span className={styles.haloSecondary} />
      <span className={styles.starsFar} />
      <span className={styles.starsMid} />
      <span className={styles.starsNear} />
      {grid && <span className={styles.grid} />}
      {grain && <span className={styles.grain} />}
      {vignette && <span className={styles.vignette} />}
    </div>
  );
};

export default MoonBackdrop;
