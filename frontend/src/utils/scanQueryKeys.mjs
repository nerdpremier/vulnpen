/**
 * The react-query keys behind the scan surfaces.
 *
 * The scans list, one scan's detail and the test plan all invalidate each
 * other — a scan writes case statuses and findings onto the plan — so a key
 * typed by hand in six files is how invalidations silently go missing. Every
 * consumer builds the key from here.
 */

/** The session's scan history (`/session/<id>/scans` and the sidebar badge). */
export const scansKey = (sessionId) => ["scans", sessionId];

/** One scan's detail (the report page's poll). */
export const scanKey = (sessionId, runId) => ["scan", sessionId, runId];

/** The session's WSTG test plan — the live source of per-case status. */
export const testPlanKey = (sessionId) => ["test-plan", sessionId];
