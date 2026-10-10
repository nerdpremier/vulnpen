/**
 * The CVSS base-metric sets FIRST publishes, one per version, and the reader
 * that turns a stored vector string back into them.
 *
 * Each version names its own metrics and takes its own values: v3.0 has Scope
 * and a bare C/I/A; v4.0 splits impact into the vulnerable system (VC/VI/VA)
 * and the subsequent system (SC/SI/SA) and adds Attack Requirements; v2.0 has
 * Authentication and no Scope at all. A finding is scored once in v3.0 and the
 * other versions are derived server-side, but every version stores the vector
 * it was scored from — so the grid can read the version the dial is reading
 * instead of showing v3.0's metrics under a v4.0 score.
 *
 * The weight is how much a value amplifies the score — amber for the setting
 * that makes the finding worst, faint for the mildest — never a verdict.
 */

const CIA_V3 = { H: ["High", "high"], L: ["Low", "mid"], N: ["None", "low"] };
const CIA_V4 = { H: ["High", "high"], L: ["Low", "mid"], N: ["None", "low"] };
const CIA_V2 = { C: ["Complete", "high"], P: ["Partial", "mid"], N: ["None", "low"] };

const METRIC_SETS = {
  "3.0": [
    {
      key: "AV",
      label: "Attack Vector",
      values: { N: ["Network", "high"], A: ["Adjacent", "mid"], L: ["Local", "low"], P: ["Physical", "low"] },
    },
    { key: "AC", label: "Attack Complexity", values: { L: ["Low", "high"], H: ["High", "low"] } },
    {
      key: "PR",
      label: "Privileges Required",
      values: { N: ["None", "high"], L: ["Low", "mid"], H: ["High", "low"] },
    },
    { key: "UI", label: "User Interaction", values: { N: ["None", "high"], R: ["Required", "low"] } },
    { key: "S", label: "Scope", values: { C: ["Changed", "high"], U: ["Unchanged", "low"] } },
    { key: "C", label: "Confidentiality", values: CIA_V3 },
    { key: "I", label: "Integrity", values: CIA_V3 },
    { key: "A", label: "Availability", values: CIA_V3 },
  ],
  "4.0": [
    {
      key: "AV",
      label: "Attack Vector",
      values: { N: ["Network", "high"], A: ["Adjacent", "mid"], L: ["Local", "low"], P: ["Physical", "low"] },
    },
    { key: "AC", label: "Attack Complexity", values: { L: ["Low", "high"], H: ["High", "low"] } },
    { key: "AT", label: "Attack Requirements", values: { N: ["None", "high"], P: ["Present", "low"] } },
    {
      key: "PR",
      label: "Privileges Required",
      values: { N: ["None", "high"], L: ["Low", "mid"], H: ["High", "low"] },
    },
    {
      key: "UI",
      label: "User Interaction",
      values: { N: ["None", "high"], P: ["Passive", "mid"], A: ["Active", "low"] },
    },
    { key: "VC", label: "Confidentiality (vulnerable system)", values: CIA_V4 },
    { key: "VI", label: "Integrity (vulnerable system)", values: CIA_V4 },
    { key: "VA", label: "Availability (vulnerable system)", values: CIA_V4 },
    { key: "SC", label: "Confidentiality (subsequent system)", values: CIA_V4 },
    { key: "SI", label: "Integrity (subsequent system)", values: CIA_V4 },
    { key: "SA", label: "Availability (subsequent system)", values: CIA_V4 },
  ],
  "2.0": [
    {
      key: "AV",
      label: "Access Vector",
      values: { L: ["Local", "low"], A: ["Adjacent Network", "mid"], N: ["Network", "high"] },
    },
    {
      key: "AC",
      label: "Access Complexity",
      values: { H: ["High", "low"], M: ["Medium", "mid"], L: ["Low", "high"] },
    },
    {
      key: "Au",
      label: "Authentication",
      values: { M: ["Multiple", "low"], S: ["Single", "mid"], N: ["None", "high"] },
    },
    { key: "C", label: "Confidentiality Impact", values: CIA_V2 },
    { key: "I", label: "Integrity Impact", values: CIA_V2 },
    { key: "A", label: "Availability Impact", values: CIA_V2 },
  ],
};

/** The version's official metric definitions, in the order FIRST publishes them. */
export function cvssMetricSet(versionId) {
  return METRIC_SETS[String(versionId)] ?? [];
}

/** The vector string the finding carries for one version, if any. */
export function cvssVectorFor(vulnerability, versionId) {
  const cvss = vulnerability?.cvss;
  if (!cvss) return "";
  if (versionId === "4.0") return cvss.v4?.vector ?? "";
  if (versionId === "2.0") return cvss.v2?.vector ?? "";
  return cvss.vector ?? "";
}

/**
 * One version's vector string back into that version's metrics: the entries
 * the grid renders, in the version's own order. A vector names its own version
 * as a prefix (`CVSS:3.0/...`) or omits it entirely (v2's
 * `AV:N/AC:L/Au:N/C:P/I:N/A:N`), so only the pairs after the first `/` are
 * read, and a value outside the version's vocabulary is dropped rather than
 * mislabelled.
 */
export function parseCvssVector(vector, versionId) {
  const definitions = cvssMetricSet(versionId);
  if (!definitions.length || typeof vector !== "string" || !vector) return [];

  const tokens = new Map();
  for (const part of vector.split("/")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    tokens.set(part.slice(0, separator).trim().toUpperCase(), part.slice(separator + 1).trim().toUpperCase());
  }

  const metrics = [];
  for (const definition of definitions) {
    const raw = tokens.get(definition.key.toUpperCase());
    const entry = raw ? definition.values[raw] : null;
    if (!entry) continue;
    metrics.push({
      short: definition.key,
      label: definition.label,
      raw,
      valueLabel: entry[0],
      weight: entry[1],
    });
  }
  return metrics;
}

/**
 * The metric grid for the version the dial is reading.
 *
 * Returns the version the grid actually describes alongside its metrics: a
 * scored finding always carries the vector it was scored from, but if one is
 * missing the v3.0 metrics are the record's own source of truth — and the
 * label has to say so rather than name a version it is not showing.
 */
export function cvssMetricFingerprint(vulnerability, versionId) {
  const own = parseCvssVector(cvssVectorFor(vulnerability, versionId), versionId);
  if (own.length) return { versionId: String(versionId), metrics: own };

  const source = parseCvssVector(cvssVectorFor(vulnerability, "3.0"), "3.0");
  return { versionId: "3.0", metrics: source };
}
