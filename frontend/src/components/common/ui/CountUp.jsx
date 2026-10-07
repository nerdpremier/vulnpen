"use client";

import { useEffect, useRef, useState } from "react";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Animated counter (React Bits "Count Up").
 *
 * On mount it eases 0 -> value. On a *change* it eases from the number already
 * on screen to the new one: a scan's counters are polled every couple of
 * seconds, and a tile that flashed back to 0 before climbing to 6 on every
 * refresh read as a glitch rather than as progress. Users who ask for reduced
 * motion land on the final value on the first frame.
 *
 * Every state write happens inside a requestAnimationFrame callback, which
 * keeps the effect free of synchronous re-render cascades.
 */
const CountUp = ({
  end = 0,
  duration = 900,
  decimals = 0,
  prefix = "",
  suffix = "",
  className = "",
}) => {
  const reduced = prefersReducedMotion();
  const [value, setValue] = useState(() => (reduced ? end : 0));
  /** The number the last animation landed on - where the next one starts. */
  const drawnRef = useRef(reduced ? end : 0);
  const frameRef = useRef(null);

  useEffect(() => {
    const still = prefersReducedMotion() || !Number.isFinite(end);

    if (still) {
      frameRef.current = requestAnimationFrame(() => {
        setValue(end);
        drawnRef.current = end;
      });
      return () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
      };
    }

    const from = Number.isFinite(drawnRef.current) ? drawnRef.current : 0;
    if (from === end) return undefined;

    const start = performance.now();
    const step = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      // easeOutExpo - fast start, soft landing
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setValue(from + (end - from) * eased);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        drawnRef.current = end;
      }
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
