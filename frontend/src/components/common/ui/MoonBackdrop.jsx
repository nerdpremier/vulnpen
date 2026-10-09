import styles from "./ui.module.scss";

/**
 * Decorative canvas layer (flat near-black, engineering texture only).
 * Purely presentational: aria-hidden and pointer-events: none, so it can sit
 * behind any page or hero block. Draws a faint hairline grid and a scanline
 * wash — the texture of an instrument, not an atmosphere.
 *
 * @param {"page"|"hero"} variant  `page` pins the layer to the viewport, `hero`
 *                                 fills the nearest positioned ancestor.
 * @param grid                     draw the hairline grid (off by default)
 * @param scanlines                draw the horizontal scanline wash (off by default)
 */
const MoonBackdrop = ({
  variant = "hero",
  grid = false,
  scanlines = false,
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
      {grid && <span className={styles.grid} />}
      {scanlines && <span className={styles.scanlines} />}
    </div>
  );
};

export default MoonBackdrop;
