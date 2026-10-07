/**
 * Hand a fetched blob to the browser as a file download.
 *
 * The report endpoints answer with `Content-Disposition: attachment`, but they
 * are cross-origin to the app, so the file is fetched through axios (which
 * carries the session cookie) and saved from a temporary object URL instead of
 * navigating the window at the API.
 */
export function saveBlob(blob, fileName) {
  if (typeof window === "undefined" || !blob) return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: Safari cancels the download if the URL dies
  // before it has read it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
