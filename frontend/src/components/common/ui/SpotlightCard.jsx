"use client";

import { useCallback, useRef, useState } from "react";
import styles from "./ui.module.scss";

/**
 * Card with a cursor-following spotlight and an optional glare sweep
 * (React Bits "Spotlight Card" + "Glare Hover"). The glow is driven by two CSS
 * custom properties written on mousemove, so no React re-render happens while
 * the pointer moves.
 *
 * Children stay direct descendants: the highlight layers are painted below
 * them by the module stylesheet.
 */
const SpotlightCard = ({
  as: Tag = "div",
  color = "rgba(201, 210, 226, 0.14)",
  radius = 280,
  glare = false,
  className = "",
  style,
  children,
  ...rest
}) => {
  const ref = useRef(null);
  const [hovered, setHovered] = useState(false);

  const handleMouseMove = useCallback((event) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    node.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  }, []);

  return (
    <Tag
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={[
        styles.spotlight,
        hovered ? styles.spotlightOn : "",
        glare && hovered ? styles.glareOn : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--spot-color": color, "--spot-radius": `${radius}px`, ...style }}
      {...rest}
    >
      <span className={styles.spotlightLayer} aria-hidden="true" />
      {glare && <span className={styles.glareLayer} aria-hidden="true" />}
      {children}
    </Tag>
  );
};

export default SpotlightCard;
