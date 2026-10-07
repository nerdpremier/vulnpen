import styles from "./ui.module.scss";

/**
 * A row of StatTiles drawn as one band.
 *
 * Four free-standing boxes across a page are mostly empty: each one repeats a
 * frame and its own padding, and the eye has to hunt for the four edges before
 * it can compare the numbers. A strip draws a single frame with hairline
 * dividers, so the row reads as one readout — the shape a scanner's status bar
 * has — and the tiles keep their own tones.
 *
 * @param columns  how many tiles share the first row (2 on a laptop, 1 on a
 *                 phone — the dividers follow the wrap, see `ui.module.scss`)
 */
const StatStrip = ({ className = "", children, ...rest }) => (
  <div
    className={[styles.statStrip, className].filter(Boolean).join(" ")}
    {...rest}
  >
    {children}
  </div>
);

export default StatStrip;
