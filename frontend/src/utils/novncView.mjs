/**
 * Where a live-desktop iframe points, and what it has to carry with it.
 *
 * Two components embed a noVNC frame — the Desktop tab and the Browser Agent
 * panel — and they were built independently, which is how the panel ended up
 * streaming a hard-coded `localhost:6080` (the backend's placeholder display)
 * while the agent's browser ran on the attack box's own desktop on another
 * port. The address rule lives here so the two cannot drift apart again, and
 * the frame's query string lives here because omitting the password is a
 * failure that looks like a broken panel rather than a missing parameter:
 * a desktop started with `-rfbauth` answers noVNC with "Authentication
 * required" and waits there forever.
 */

/** Add a scheme to a bare `host:port`, leaving a full URL alone. */
function withScheme(url) {
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

/**
 * The noVNC base URL to embed, or null when there is nothing to embed.
 *
 * `novncUrl` is the API's answer — where the desktop the agent is actually on
 * lives, which may be another machine entirely. When it is absent the stream
 * is the backend's own stack, and the host is then derived from the origin the
 * operator already reached the app on: the noVNC port is published beside the
 * API's, so anything but localhost has to follow the app's host rather than be
 * hard-coded to localhost.
 */
export function resolveNovncBase({ novncUrl, novncPort, backendUrl } = {}) {
  const explicit = typeof novncUrl === "string" ? novncUrl.trim() : "";
  if (explicit) return withScheme(explicit);

  if (!novncPort) return null;

  try {
    const origin = new URL(backendUrl);
    return `${origin.protocol}//${origin.hostname}:${novncPort}`;
  } catch {
    return `http://localhost:${novncPort}`;
  }
}

/**
 * The `vnc.html` URL for an iframe.
 *
 * The password is encoded with `encodeURIComponent` rather than left to
 * `URLSearchParams`: noVNC reads the query with `decodeURIComponent`, which
 * turns the `+` that form-encoding produces into a space and fails the
 * handshake for any password containing one.
 */
export function novncFrameSrc(base, password) {
  if (!base) return null;
  const auth = password ? `password=${encodeURIComponent(password)}&` : "";
  return `${base}/vnc.html?${auth}resize=scale&autoconnect=true`;
}
