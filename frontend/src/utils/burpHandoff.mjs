/**
 * Burp handoff — the cross-page protocol that carries a request captured in
 * the Burp proxy page into the chat composer. Owns the sessionStorage key, the
 * completion event and the message builder, so neither surface re-derives the
 * payload format.
 */

export const BURP_HANDOFF_KEY = "burp-to-workspace";

/**
 * Fired on `window` the moment a handoff is stashed.
 *
 * Storage alone is not enough. The Burp rail panel and the chat are both
 * rendered by the chat route (`/session/[id]/chat`), so "attach to workspace"
 * from the rail is a push to the page it is already on: nothing remounts,
 * nothing re-reads storage, and the payload strands — the toast fires and no
 * attachment ever appears. This event lets a chat that is already mounted pick
 * it up. When the routes differ (the full Burp page) it is simply unheard, and
 * the mount-time read still finds the payload in storage.
 */
export const BURP_HANDOFF_EVENT = "burp-handoff";

/** Stash a captured request for the chat, and announce it. */
export function stashBurpHandoff(
  attachment,
  { key = BURP_HANDOFF_KEY, storage = sessionStorage, target = window } = {},
) {
  storage.setItem(key, JSON.stringify(attachment));
  target.dispatchEvent(new CustomEvent(BURP_HANDOFF_EVENT));
}

/** Subscribe to stashed handoffs; returns an unsubscribe function. */
export function subscribeBurpHandoff(handler, target = window) {
  target.addEventListener(BURP_HANDOFF_EVENT, handler);
  return () => target.removeEventListener(BURP_HANDOFF_EVENT, handler);
}

/**
 * Consume the handoff once: read, remove, parse. Returns null when nothing
 * is pending or the payload is not valid JSON.
 */
export function takeBurpHandoff(storage = sessionStorage) {
  const pending = storage.getItem(BURP_HANDOFF_KEY);
  if (!pending) return null;
  storage.removeItem(BURP_HANDOFF_KEY);
  try {
    return JSON.parse(pending);
  } catch {
    return null;
  }
}

/**
 * The prompt message for a request handed over from Burp: the operator's own
 * text when they wrote one, otherwise a default ask, plus the request facts
 * and the raw exchange. Returns the text and the burpMeta stamped on the
 * pending chat message.
 */
export function buildBurpMessage(userText, attachment) {
  const scheme = attachment.secure ? "https" : "http";
  const target = `${attachment.method} ${scheme}://${attachment.host}${attachment.path}`;
  const tls = attachment.secure ? "Yes" : "No";

  let msg = "";
  if (userText.trim()) {
    msg += `${userText.trim()}\n\n`;
  } else {
    msg += `Analyze and pentest the following HTTP request captured from ${attachment.sourceName || "Burp Suite"} proxy:\n\n`;
  }
  msg += `Target: ${target}\n`;
  msg += `Host: ${attachment.host} | Port: ${attachment.port || 443} | TLS: ${tls}\n\n`;
  msg += `--- RAW REQUEST ---\n${attachment.rawRequest || "(empty)"}\n--- END REQUEST ---\n`;
  if (attachment.rawResponse) {
    msg += `\n--- RAW RESPONSE ---\n${attachment.rawResponse}\n--- END RESPONSE ---\n`;
  }
  if (!userText.trim()) {
    msg += `\nAnalyze this request for potential vulnerabilities and suggest testing categories.`;
  }
  return {
    text: msg,
    burpMeta: {
      method: attachment.method,
      host: attachment.host,
      path: attachment.path,
      port: attachment.port,
      secure: attachment.secure,
      statusCode: attachment.statusCode,
    },
  };
}
