"use client";

import { useEffect, useRef, useState } from "react";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Animated counter (React Bits "Count Up"). Eases 0 -> value once on mount.
 *
 * Every state write happens inside a requestAnimationFrame callback, which
 * keeps the effect free of synchronous re-render cascades. Users who ask for
 * reduced motion land on the final value on the first frame.
 */
const CountUp = ({
  end = 0,
  duration = 900,
  decimals = 0,
  prefix = "",
  suffix = "",
  className = "",
}) => {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? end : 0));
  const frameRef = useRef(null);

  useEffect(() => {
    const reduced = prefersReducedMotion() || !Number.isFinite(end);
    const start = performance.now();
    const from = reduced ? end : 0;

    const step = (now) => {
      const progress = reduced ? 1 : Math.min((now - start) / duration, 1);
      // easeOutExpo - fast start, soft landing
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setValue(from + (end - from) * eased);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [end, duration]);

  const display = Number.isFinite(value) ? value.toFixed(decimals) : end;

  return (
    <span className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
};

export default CountUp;
