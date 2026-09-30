/**
 * Message to show when a request fails: whatever the server said, plus the HTTP status so a
 * missing or mismatched endpoint is obvious in the UI instead of hiding behind a fallback.
 */
export function apiErrorMessage(error, fallback) {
  const status = error?.response?.status;
  const server = error?.response?.data?.message;
  if (server) return status ? `${server} (HTTP ${status})` : server;
  if (status) return `${fallback} (HTTP ${status})`;
  return fallback;
}