/**
 * Format Magnitude browser agent errors with helpful suggestions.
 */
export function formatMagnitudeError(error: { message?: string }): string {
  const msg = error?.message ?? "";
  const isXServerError =
    /X server|XServer|headed browser|Missing X server|\$DISPLAY/i.test(msg) ||
    /xvfb-run|without having a XServer/i.test(msg);

  if (isXServerError) {
    return `${msg} — To fix: set up VNC (Settings → VNC) for headed mode, or enable headless mode (Settings → Magnitude → Headless).`;
  }
  return msg;
}

/**
 * Provider-side failure of the browser agent's own LLM. 429/5xx are transient
 * (worth retrying); 404 usually means the model is gone from the provider, so
 * retrying is pointless and only a different assignment helps.
 */
export function isTransientBrowserLlmFailure(message: string): boolean {
  return /\b(429|500|502|503|504)\b|rate.?limit|too many requests/i.test(message);
}

/** Actionable hint appended when the browser agent's LLM keeps failing. */
export function browserLlmErrorHint(message: string, modelLabel?: string): string {
  const model = modelLabel ? `"${modelLabel}"` : "assigned";
  if (/\b404\b|model not found|no endpoints found/i.test(message)) {
    return (
      `\n\nThe Browser Agent model ${model} is unavailable at its provider (404) even after ` +
      "retries. Assign a different model for the Browser Agent in Settings → Models, then retry."
    );
  }
  if (isTransientBrowserLlmFailure(message)) {
    return (
      `\n\nThe Browser Agent model ${model} was rate limited even after retries — it likely ` +
      "shares traffic with the orchestrator. Assign a dedicated model for the Browser Agent in " +
      "Settings → Models for reliable browser runs."
    );
  }
  return "";
}
