/**
 * CVSS v3.0 base metrics and the base score equation, exactly as published by
 * FIRST (https://www.first.org/cvss/v3.0/specification-document) and exposed by
 * the official calculator (https://www.first.org/cvss/calculator/3.0). Only the
 * Base Score group is used — Temporal and Environmental metrics do not exist here.
 *
 * The model rates the eight base metrics (AV, AC, PR, UI, S, C, I, A); the
 * score, the vector string and the severity band are computed here, so two
 * raters with the same metrics always land on the same severity and a declared
 * severity word is never accepted on its own.
 * Reference data only: no I/O.
 */

export type AttackVector = "N" | "A" | "L" | "P";
export type AttackComplexity = "L" | "H";
export type PrivilegesRequired = "N" | "L" | "H";
export type UserInteraction = "N" | "R";
export type Scope = "U" | "C";
export type CiaImpact = "N" | "L" | "H";

export interface CvssBaseMetrics {
  av: AttackVector;
  ac: AttackComplexity;
  pr: PrivilegesRequired;
  ui: UserInteraction;
  s: Scope;
  c: CiaImpact;
  i: CiaImpact;
  a: CiaImpact;
}

/** The qualitative severity ratings FIRST publishes for the base score. */
export type CvssSeverity = "critical" | "high" | "medium" | "low" | "none";

const WEIGHTS = {
  av: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  ac: { L: 0.77, H: 0.44 },
  // Privileges Required is the one metric whose weight depends on Scope.
  pr: { U: { N: 0.85, L: 0.62, H: 0.27 }, C: { N: 0.85, L: 0.68, H: 0.5 } },
  ui: { N: 0.85, R: 0.62 },
  cia: { N: 0, L: 0.22, H: 0.56 },
} as const;

/**
 * The spec's Roundup: the smallest number with one decimal place that is
 * greater than or equal to the input. Done on an integer ladder (the spec's
 * own workaround) so IEEE 754 artefacts such as 4.0 rounding to 4.1 cannot
 * happen.
 */
function roundup(value: number): number {
  const scaled = Math.round(value * 100_000);
  if (scaled % 10_000 === 0) return scaled / 100_000;
  return (Math.floor(scaled / 10_000) + 1) / 10;
}

/** The CVSS v3.0 base score equation for a complete set of base metrics. */
export function cvssBaseScore(metrics: CvssBaseMetrics): number {
  const iss = 1 - (1 - WEIGHTS.cia[metrics.c]) * (1 - WEIGHTS.cia[metrics.i]) * (1 - WEIGHTS.cia[metrics.a]);
  const impact =
    metrics.s === "U"
      ? 6.42 * iss
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;
  const exploitability =
    8.22 * WEIGHTS.av[metrics.av] * WEIGHTS.ac[metrics.ac] * WEIGHTS.pr[metrics.s][metrics.pr] * WEIGHTS.ui[metrics.ui];
  if (metrics.s === "U") return roundup(Math.min(impact + exploitability, 10));
  return roundup(Math.min(1.08 * (impact + exploitability), 10));
}

/** The canonical vector string, e.g. "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H". */
export function cvssVectorString(metrics: CvssBaseMetrics): string {
  return (
    `CVSS:3.0/AV:${metrics.av}/AC:${metrics.ac}/PR:${metrics.pr}/UI:${metrics.ui}` +
    `/S:${metrics.s}/C:${metrics.c}/I:${metrics.i}/A:${metrics.a}`
  );
}

/** 0.0 None · 0.1–3.9 Low · 4.0–6.9 Medium · 7.0–8.9 High · 9.0–10.0 Critical. */
export function cvssQualitativeRating(score: number): CvssSeverity {
  if (score <= 0) return "none";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
}

const METRIC_FIELDS: Array<{ key: keyof CvssBaseMetrics; values: string[] }> = [
  { key: "av", values: ["N", "A", "L", "P"] },
  { key: "ac", values: ["L", "H"] },
  { key: "pr", values: ["N", "L", "H"] },
  { key: "ui", values: ["N", "R"] },
  { key: "s", values: ["U", "C"] },
  { key: "c", values: ["N", "L", "H"] },
  { key: "i", values: ["N", "L", "H"] },
  { key: "a", values: ["N", "L", "H"] },
];

/**
 * Parse the eight base metrics from agent-supplied data. Accepts a `cvss`
 * object, flat metric fields (av, ac, … or the long names attackVector,
 * attackComplexity, …) or a full vector string. Returns undefined unless every
 * metric is present and valid — a partial rating is never scored.
 */
export function normalizeCvssBaseMetrics(data: Record<string, any>): CvssBaseMetrics | undefined {
  const source =
    data.cvss && typeof data.cvss === "object" && !Array.isArray(data.cvss)
      ? (data.cvss as Record<string, any>)
      : data;

  const aliases: Record<keyof CvssBaseMetrics, string[]> = {
    av: ["av", "attackVector", "attack_vector"],
    ac: ["ac", "attackComplexity", "attack_complexity"],
    pr: ["pr", "privilegesRequired", "privileges_required"],
    ui: ["ui", "userInteraction", "user_interaction"],
    s: ["s", "scope"],
    c: ["c", "confidentiality", "confidentialityImpact"],
    i: ["i", "integrity", "integrityImpact"],
    a: ["a", "availability", "availabilityImpact"],
  };

  const metrics = {} as CvssBaseMetrics;
  for (const { key, values } of METRIC_FIELDS) {
    let raw = aliases[key]
      .map((alias) => source[alias])
      .find((value) => value != null && value !== "");
    // A full "CVSS:3.0/AV:.../..." string can also carry the metrics.
    if (raw == null && typeof source.vector === "string") {
      raw = source.vector.match(new RegExp(`/(?:${key.toUpperCase()}):([A-Za-z])(?:/|$)`))?.[1];
    }
    if (raw == null) return undefined;
    const letter = String(raw).trim().toUpperCase();
    if (!values.includes(letter)) return undefined;
    metrics[key] = letter as never;
  }
  return metrics;
}

/** Parse a complete vector string into base metrics, or undefined if invalid. */
export function parseCvssVector(vector: string): CvssBaseMetrics | undefined {
  if (!/^CVSS:3\.[01]\//i.test(vector.trim())) return undefined;
  return normalizeCvssBaseMetrics({ vector });
}

/**
 * One score → one finding severity band. CVSS "None" (0.0) maps to the
 * informational band: a finding whose metrics say no impact is recorded for
 * completeness, not rated.
 */
export function severityFromCvssScore(score: number): "critical" | "high" | "medium" | "low" | "info" {
  const rating = cvssQualitativeRating(score);
  return rating === "none" ? "info" : rating;
}

/**
 * CVSS v2.0 base score, derived from the same v3.0 base metrics so a finding
 * carries one rating rendered in all three versions. The two specs measure
 * different axes, so the mapping is the closest equivalence, not a rewrite:
 * v3 PrivilegesRequired becomes v2 Authentication (none→none, low→single,
 * high→multiple) and v3 C/I/A map N/L/H onto none/partial/complete. The
 * equation is the FIRST v2.0 guide
 * (https://www.first.org/cvss/v2/guide), including its f(impact) factor and
 * round-to-one-decimal (not roundup).
 */
export type CvssV2AccessVector = "L" | "A" | "N";
export type CvssV2AccessComplexity = "L" | "H";
export type CvssV2Authentication = "N" | "S" | "M";
export type CvssV2Cia = "N" | "P" | "C";

export interface CvssV2Metrics {
  av: CvssV2AccessVector;
  ac: CvssV2AccessComplexity;
  au: CvssV2Authentication;
  c: CvssV2Cia;
  i: CvssV2Cia;
  a: CvssV2Cia;
}

const V2_WEIGHTS = {
  av: { L: 0.395, A: 0.646, N: 1.0 },
  ac: { L: 0.71, H: 0.35 },
  au: { N: 0.704, S: 0.56, M: 0.45 },
  cia: { N: 0, P: 0.275, C: 0.66 },
} as const;

export function deriveCvssV2Metrics(metrics: CvssBaseMetrics): CvssV2Metrics {
  return {
    av: metrics.av === "P" ? "A" : metrics.av,
    ac: metrics.ac,
    au: metrics.pr === "N" ? "N" : metrics.pr === "L" ? "S" : "M",
    c: metrics.c === "H" ? "C" : metrics.c === "L" ? "P" : "N",
    i: metrics.i === "H" ? "C" : metrics.i === "L" ? "P" : "N",
    a: metrics.a === "H" ? "C" : metrics.a === "L" ? "P" : "N",
  };
}

/** The CVSS v2.0 base score equation, with the spec's f(impact) multiplier. */
export function cvssV2BaseScore(metrics: CvssV2Metrics): number {
  const impact = 10.41 * (1 - (1 - V2_WEIGHTS.cia[metrics.c]) * (1 - V2_WEIGHTS.cia[metrics.i]) * (1 - V2_WEIGHTS.cia[metrics.a]));
  if (impact <= 0) return 0;
  const exploitability = 20 * V2_WEIGHTS.av[metrics.av] * V2_WEIGHTS.ac[metrics.ac] * V2_WEIGHTS.au[metrics.au];
  const fImpact = 1.176;
  const base = (0.6 * impact + 0.4 * exploitability - 1.5) * fImpact;
  return Math.round(Math.min(base, 10) * 10) / 10;
}

export function cvssV2VectorString(metrics: CvssV2Metrics): string {
  return `AV:${metrics.av}/AC:${metrics.ac}/Au:${metrics.au}/C:${metrics.c}/I:${metrics.i}/A:${metrics.a}`;
}

/**
 * CVSS v4.0 base score, computed with the FIRST reference implementation
 * (the cvss4 package) from metrics derived the same way: AV, AC, PR carry
 * over unchanged; UI R→Y; C/I/A feed VC/VI/VA. AT (exploit maturity) and the
 * subsequent-system metrics SC/SI/SA cannot be inferred from a v3 rating and
 * default to N — the same defaults the official calculator applies to
 * unrated metrics, so v4 lands slightly below v3 when scope change mattered.
 */
export interface CvssScoredVersion {
  score: number;
  vector: string;
}

export function deriveCvssV4Vector(metrics: CvssBaseMetrics): string {
  return (
    `CVSS:4.0/AV:${metrics.av}/AC:${metrics.ac}/AT:N/PR:${metrics.pr}/UI:${metrics.ui === "R" ? "Y" : "N"}` +
    `/VC:${metrics.c}/VI:${metrics.i}/VA:${metrics.a}/SC:N/SI:N/SA:N`
  );
}

function cvssV4BaseScore(vector: string): number {
  try {
    const { calculateBaseScoreV4 } = require("cvss4") as { calculateBaseScoreV4: (vector: string) => number };
    const score = calculateBaseScoreV4(vector);
    return typeof score === "number" && score >= 0 ? score : 0;
  } catch {
    return 0;
  }
}

/** Score everything at once: metrics → score, vector and severity band. */
export function computeCvssBase(
  metrics: CvssBaseMetrics,
): CvssBaseMetrics & { score: number; vector: string; severity: "critical" | "high" | "medium" | "low" | "info" } & {
  v2: CvssScoredVersion;
  v4: CvssScoredVersion;
} {
  const score = cvssBaseScore(metrics);
  const v2Metrics = deriveCvssV2Metrics(metrics);
  const v4Vector = deriveCvssV4Vector(metrics);
  return {
    ...metrics,
    score,
    vector: cvssVectorString(metrics),
    severity: severityFromCvssScore(score),
    v2: { score: cvssV2BaseScore(v2Metrics), vector: cvssV2VectorString(v2Metrics) },
    v4: { score: cvssV4BaseScore(v4Vector), vector: v4Vector },
  };
}
