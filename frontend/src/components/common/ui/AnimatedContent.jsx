import styles from "./ui.module.scss";

const DIRECTIONS = {
  up: styles.reveal,
  down: styles.revealDown,
  left: styles.revealLeft,
  right: styles.revealRight,
  none: styles.revealNone,
};

/**
 * Entrance reveal (React Bits "Animated Content", CSS-only variant).
 *
 * Deliberately animation-only: the class ships in the server-rendered markup,
 * so the reveal runs on first paint with no flash and still completes with
 * JavaScript disabled. `prefers-reduced-motion` is honoured globally.
 *
 * @param delay  ms before the reveal starts - use an index for list stagger
 */
const AnimatedContent = ({
  as: Tag = "div",
  direction = "up",
  delay = 0,
  className = "",
  style,
  children,
  ...rest
}) => (
  <Tag
    className={[DIRECTIONS[direction] || styles.reveal, className]
      .filter(Boolean)
      .join(" ")}
    style={{ "--reveal-delay": `${delay}ms`, ...style }}
    {...rest}
  >
    {children}
  </Tag>
);

export default AnimatedContent;
