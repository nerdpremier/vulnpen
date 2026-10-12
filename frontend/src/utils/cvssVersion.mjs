/**
 * The one CVSS version the finding surfaces read in, and the reader that takes
 * a finding's score in any of them.
 *
 * A finding is scored once in v3.0 and the other versions are derived from the
 * same metrics, so the same finding has three base scores and every surface
 * has to agree on which one is on screen. The list and the detail each used to
 * decide for themselves — the list pinned v3.0, the detail opened on v4.0 —
 * so the front said 5.3 and the page it opened said 6.9 for the same finding.
 *
 * This module owns that decision: the version ids, the persisted choice that
 * survives navigation, the event that keeps two mounted surfaces in step (the
 * same reason the Burp handoff carries one — a picker and the page it feeds can
 * both be mounted at once), and the per-version reader with its fallback for a
 * finding recorded before a derived version existed.
 *
 * Newest FIRST version first in the selector, but the version a surface shows
 * before anything is chosen is v3.0: that is the rating the system computes
 * from the base metrics, the one the severity bands, the report and the
 * scan's "severity base" all state, and v4.0/v2.0 are the same finding rendered
 * in those versions. Picking another version moves every surface to it.
 */

export const CVSS_VERSION_IDS = ["4.0", "3.0", "2.0"];

/** The version shown when nothing has been chosen yet — the computed rating. */
export const DEFAULT_CVSS_VERSION = "3.0";

export const CVSS_VERSION_STORAGE_KEY = "cvss-version";

/** Fired on `window` whenever the choice changes, so a mounted surface follows. */
export const CVSS_VERSION_EVENT = "cvss-version-change";

/** The bands a base score is binned into, per version. v2.0 has no "None" band
    and folds the top of the scale into High — the v3.0/v4.0 cut points do not
    apply to it. */
const BANDS_V3_V4 = [
  { key: "none", axis: "0.0", label: "0.0 (None)", tone: "mute", min: 0, max: 0.1 },
  { key: "low", axis: "low", label: "0.1–3.9", tone: "low", min: 0.1, max: 4 },
  { key: "medium", axis: "medium", label: "4.0–6.9", tone: "medium", min: 4, max: 7 },
  { key: "high", axis: "high", label: "7.0–8.9", tone: "high", min: 7, max: 9 },
  { key: "critical", axis: "critical", label: "9.0–10", tone: "critical", min: 9, max: 10.1 },
];

const BANDS_V2 = [
  { key: "low", axis: "low", label: "0.0–3.9", tone: "low", min: 0, max: 4 },
  { key: "medium", axis: "medium", label: "4.0–6.9", tone: "medium", min: 4, max: 7 },
  { key: "high", axis: "high", label: "7.0–10", tone: "high", min: 7, max: 10.1 },
];

export function cvssBandsFor(versionId) {
  return versionId === "2.0" ? BANDS_V2 : BANDS_V3_V4;
}

export function isCvssVersionId(value) {
  return CVSS_VERSION_IDS.includes(String(value));
}

/** The label every surface prints for a version, e.g. "CVSS v4.0". */
export function cvssVersionLabel(versionId) {
  return `CVSS v${versionId}`;
}

/**
 * The severity word for a base score in one version. v2.0 has no Critical band
 * — its published ratings stop at High — so the same score reads one step lower
 * there than it does under v3.0/v4.0. This is the word the dial's tone and the
 * row badge take, kept next to the score reader so the two never drift.
 */
export function cvssSeverityWord(score, versionId) {
  if (!(typeof score === "number") || !Number.isFinite(score)) return "info";
  if (score <= 0) return "info";
  if (versionId === "2.0") {
    if (score < 4) return "low";
    if (score < 7) return "medium";
    return "high";
  }
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
}

/**
 * One finding's score and vector in one version, or null when it carries none.
 * Only the stored numeric score counts — a missing or non-finite one is the
 * same as unrated, which is what the switcher and the list both show.
 */
export function cvssVersionScore(cvss, versionId) {
  if (!cvss || !isCvssVersionId(versionId)) return null;
  const source =
    versionId === "4.0" ? cvss.v4 : versionId === "2.0" ? cvss.v2 : { score: cvss.score, vector: cvss.vector };
  if (!source || typeof source.score !== "number" || !Number.isFinite(source.score)) return null;
  return { score: source.score, vector: source.vector ?? "" };
}

/** The versions a finding is actually scored in, newest first. */
export function cvssVersionsFor(finding) {
  return CVSS_VERSION_IDS.map((id) => {
    const scored = cvssVersionScore(finding?.cvss, id);
    return scored ? { id, label: cvssVersionLabel(id), score: scored.score, vector: scored.vector } : null;
  }).filter(Boolean);
}

/**
 * The version to display for a finding: the chosen one when the finding carries
 * it, otherwise the newest it does carry. A finding recorded before a derived
 * version existed still shows a real score rather than a dash.
 */
export function cvssVersionFor(finding, preferredId) {
  const available = cvssVersionsFor(finding);
  if (!available.length) return null;
  return available.find((version) => version.id === preferredId) ?? available[0];
}

/** The base score to print for a finding under the chosen version, or null. */
export function cvssScoreFor(finding, preferredId) {
  return cvssVersionFor(finding, preferredId)?.score ?? null;
}

function defaultStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function defaultTarget() {
  return typeof window === "undefined" ? null : window;
}

/** The persisted choice, or the default when none is stored or storage is shut. */
export function readCvssVersion(storage = defaultStorage(), fallback = DEFAULT_CVSS_VERSION) {
  try {
    const stored = storage?.getItem(CVSS_VERSION_STORAGE_KEY);
    return isCvssVersionId(stored) ? String(stored) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist the choice and announce it. The event is what keeps the other mounted
 * surface in step; storage alone is only read at mount.
 */
export function writeCvssVersion(versionId, { storage = defaultStorage(), target = defaultTarget() } = {}) {
  if (!isCvssVersionId(versionId)) return;
  try {
    storage?.setItem(CVSS_VERSION_STORAGE_KEY, String(versionId));
  } catch {
    /* private mode / storage disabled: the event still updates mounted views */
  }
  target?.dispatchEvent(new CustomEvent(CVSS_VERSION_EVENT, { detail: { versionId: String(versionId) } }));
}

/** Subscribe to choice changes; returns an unsubscribe function. */
export function subscribeCvssVersion(handler, target = defaultTarget()) {
  if (!target) return () => {};
  target.addEventListener(CVSS_VERSION_EVENT, handler);
  return () => target.removeEventListener(CVSS_VERSION_EVENT, handler);
}
