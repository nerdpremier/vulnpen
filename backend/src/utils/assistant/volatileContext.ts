/**
 * Owner of the <volatile_system> protocol: the cache-splitting contract
 * between the agent loop, the prompt builders and the Anthropic adapter.
 *
 * The static system prompt is prompt-cached by the provider; everything that
 * changes between turns or tool-loop iterations (run clock, engagement state,
 * WSTG plan and risk posture) is rendered into a tail appended AFTER the
 * static content, delimited by <volatile_system>. The Anthropic request
 * builder splits on the marker so the tail sits after the cache breakpoint
 * and is re-read uncached instead of invalidating the whole system cache.
 *
 * Every read or write of that marker goes through this module — the string
 * literal must not appear anywhere else.
 */

export const VOLATILE_SYSTEM_MARKER = "<volatile_system>";

/** Render the volatile tail from its per-iteration parts. */
export function buildVolatileTail(parts: {
  timezone: string;
  /** Rendered engagement state block, or "" when the state is empty. */
  stateBlock: string;
  /** Rendered WSTG plan + OWASP risk posture. */
  webApp: string;
}): string {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    `${VOLATILE_SYSTEM_MARKER}\n<run_clock>Current time: ${time} ${parts.timezone}</run_clock>` +
    `${parts.stateBlock}\n${parts.webApp}\n</${VOLATILE_SYSTEM_MARKER.slice(1, -1)}>`
  );
}

/**
 * Replace (or append) the volatile tail on the system message content.
 * Idempotent: injecting twice leaves the freshest tail, never two of them.
 */
export function injectVolatileTail(sysContent: string, tail: string): string {
  const markerStart = sysContent.indexOf(VOLATILE_SYSTEM_MARKER);
  return markerStart !== -1
    ? sysContent.slice(0, markerStart) + tail
    : sysContent + "\n\n" + tail;
}

/** Split system-message content at the marker: static prefix vs volatile tail. */
export function splitVolatileTail(content: string): {
  staticPrefix: string;
  volatileTail: string;
} {
  const marker = content.indexOf(VOLATILE_SYSTEM_MARKER);
  if (marker === -1) {
    return { staticPrefix: content, volatileTail: "" };
  }
  return {
    staticPrefix: content.slice(0, marker),
    volatileTail: content.slice(marker),
  };
}
