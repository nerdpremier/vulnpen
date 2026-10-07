/**
 * Burp handoff — the cross-page protocol that carries a request captured in
 * the Burp proxy page into the chat composer. Owns the sessionStorage key and
 * the message builder, so neither surface re-derives the payload format.
 */

export const BURP_HANDOFF_KEY = "burp-to-workspace";

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
