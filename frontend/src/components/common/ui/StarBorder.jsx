import styles from "./ui.module.scss";

/**
 * Animated specular border (React Bits "Star Border", monochrome variant).
 * Wraps any block and draws a single highlight travelling around the edge.
 *
 * @param speed seconds per full revolution
 */
const StarBorder = ({
  as: Tag = "div",
  speed = 5,
  className = "",
  style,
  children,
  ...rest
}) => (
  <Tag
    className={[styles.starBorder, className].filter(Boolean).join(" ")}
    style={{ "--star-speed": `${speed}s`, ...style }}
    {...rest}
  >
    {children}
  </Tag>
);

export default StarBorder;
