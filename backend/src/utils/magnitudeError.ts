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

/**
 * Did the action happen, with only the navigation it started left unfinished?
 *
 * Playwright's action APIs wait, after dispatching, for any navigation the
 * action scheduled to finish (`waitForSignalsCreatedBy`, driver-side). A click
 * that starts a request the server never answers therefore rejects with a
 * timeout — with the element found, the event delivered, and nothing left to
 * wait for but a navigation that will never commit:
 *
 *   locator.click: Timeout 15000ms exceeded.
 *     - click action done
 *     - waiting for scheduled navigations to finish
 *
 * That is not a failed action, and the discriminator is deliberately the narrow
 * one: `action done` is logged only *after* the event has been delivered, so an
 * actionability timeout — the element never appeared, the click never happened —
 * cannot match it and must keep propagating. If a future Playwright drops the
 * wording, this returns false and the previous behaviour is preserved, which is
 * the safe direction to fail in.
 */
export function isPostActionNavigationTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /\baction done\b/i.test(message) && /scheduled navigations/i.test(message)
  );
}

/**
 * Actionable hint for a browser that cannot reach its target at all.
 *
 * The browser runs on the attack box, so a target that box cannot reach is
 * unreachable however the goal is phrased. Chromium reports that as a connection
 * error or a navigation timeout; saying why saves the agent from retrying the
 * same dead navigation.
 *
 * The timeout branch is deliberately narrow. A bare "Timeout 15000ms exceeded"
 * is *any* Playwright wait — an element that never appeared, a click whose
 * follow-up navigation never committed — and neither says anything about the
 * proxy or the VPN. Only a navigation that never committed, or a connection the
 * network stack refused, means the address itself did not answer. Blaming the
 * proxy for the rest sends the operator to a setting that is not the cause.
 */
export function browserReachabilityHint(message: string): string {
  const text = message || "";

  // The opposite of unreachable: the address answered, the click landed, and
  // only the page it started never finished loading.
  if (isPostActionNavigationTimeout(text)) return "";

  // Named codes only, not a blanket `net::ERR_`. Chromium raises ERR_* for
  // plenty of things that are not reachability — ERR_UNSAFE_PORT (a port on its
  // own blocked list), ERR_BLOCKED_BY_CLIENT, ERR_INVALID_URL, ERR_ABORTED — and
  // telling the operator to check the VPN for those is the same mistake in a
  // different costume.
  const networkError =
    /ERR_(CONNECTION|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_UNREACHABLE|ADDRESS_UNREACHABLE|ADDRESS_INVALID|INTERNET_DISCONNECTED|PROXY|TUNNEL|MANDATORY_PROXY|TIMED_OUT|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED)/i.test(
      text,
    ) || /NS_ERROR_UNKNOWN_HOST/i.test(text);

  // `page.goto`/`goBack`/`reload` log `navigating to "<url>", waiting until
  // "<state>"` in their call log, which is what separates them from every other
  // timeout Playwright can raise.
  const navigationTimeout =
    /Navigation timeout/i.test(text) ||
    (/Timeout .* exceeded/i.test(text) &&
      /\bnavigating to\b|waiting until "(?:commit|domcontentloaded|load|networkidle)"/i.test(
        text,
      ));

  if (!networkError && !navigationTimeout) return "";
  return (
    "\n\nThe browser could not reach that address. The browser runs on the attack box, so it " +
    "has that box's route — if the address is still unreachable, check the proxy it is pointed " +
    "at (Settings -> Browser Agent) and whether the VPN for this engagement is connected there. " +
    "A target the attack box itself cannot reach can also be tested with its own tools " +
    "(curl, ffuf, sqlmap) over the shell."
  );
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
