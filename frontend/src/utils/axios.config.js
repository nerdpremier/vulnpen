import axios from "axios";

/**
 * The API base, pinned to the hostname the page was loaded from.
 *
 * A local deployment sets the session cookie host-only and `SameSite=Lax`
 * (see backend/src/server.ts). A page served from `http://127.0.0.1:3000` that
 * calls `http://localhost:8080` is therefore making a *cross-site* request, and
 * the browser withholds the cookie: the API answers 401 and the UI reports
 * "Session Expired or Invalid" even though the session is perfectly valid.
 * Both spellings of loopback are in use — the launcher prints `localhost`, and
 * people type `127.0.0.1` — so mirror whichever one the operator actually
 * opened instead of hardcoding one of them.
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_BACKEND = "http://localhost:8080";

export function resolveBackendBase() {
  const configured = (process.env.NEXT_PUBLIC_BACKEND_URI || "").trim().replace(/\/+$/, "");
  if (typeof window === "undefined") {
    return configured || DEFAULT_BACKEND;
  }
  const pageHost = window.location.hostname;
  if (!configured) {
    return `${window.location.protocol}//${pageHost}:8080`;
  }
  try {
    const url = new URL(configured);
    if (
      LOOPBACK_HOSTS.includes(url.hostname) &&
      LOOPBACK_HOSTS.includes(pageHost) &&
      url.hostname !== pageHost
    ) {
      url.hostname = pageHost;
    }
    return url.origin;
  } catch {
    return configured;
  }
}

export const backendBaseURL = resolveBackendBase();
export const apiBaseURL = `${backendBaseURL}/api`;

export const apiClient = axios.create({
  baseURL: apiBaseURL,

  withCredentials: true,
  headers: {
    "Content-type": "application/json",
  },
});
