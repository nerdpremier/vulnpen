import styles from "./ui.module.scss";

/**
 * Text with a moonlit sheen travelling across the glyphs
 * (React Bits "Shiny Text", monochrome).
 *
 * @param speed  seconds for one full sweep
 */
const ShinyText = ({
  text,
  children,
  speed = 4.5,
  disabled = false,
  className = "",
  as: Tag = "span",
}) => (
  <Tag
    className={[styles.shiny, disabled ? styles.shinyPaused : "", className]
      .filter(Boolean)
      .join(" ")}
    style={{ "--shiny-duration": `${speed}s` }}
  >
    {text ?? children}
  </Tag>
);

export default ShinyText;
