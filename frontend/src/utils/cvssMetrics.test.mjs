import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cvssMetricFingerprint,
  cvssMetricSet,
  cvssVectorFor,
  parseCvssVector,
} from "./cvssMetrics.mjs";

/* The three vectors the product actually stores for one finding: v3.0 is the
   rating the system computed, v2.0 and v4.0 are the same finding derived. */
const V3 = "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N";
const V2 = "AV:N/AC:L/Au:N/C:P/I:N/A:N";
const V4 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N";

test("each version exposes its own official metric set", () => {
  assert.deepEqual(
    cvssMetricSet("3.0").map((m) => m.key),
    ["AV", "AC", "PR", "UI", "S", "C", "I", "A"],
  );
  assert.deepEqual(
    cvssMetricSet("4.0").map((m) => m.key),
    ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"],
  );
  assert.deepEqual(
    cvssMetricSet("2.0").map((m) => m.key),
    ["AV", "AC", "Au", "C", "I", "A"],
  );
  assert.deepEqual(cvssMetricSet("9.9"), []);
});

test("a version prefix is skipped and a bare v2 vector still parses", () => {
  const v3 = parseCvssVector(V3, "3.0");
  assert.equal(v3.length, 8);
  assert.equal(v3[0].valueLabel, "Network");
  assert.equal(v3[4].short, "S");
  assert.equal(v3[4].valueLabel, "Unchanged");

  const v2 = parseCvssVector(V2, "2.0");
  assert.equal(v2.length, 6);
  assert.equal(v2[2].short, "Au");
  assert.equal(v2[2].valueLabel, "None");
  assert.equal(v2[3].valueLabel, "Partial");
});

test("v4 reads both impact systems, which v3 has no vocabulary for", () => {
  const v4 = parseCvssVector(V4, "4.0");
  assert.equal(v4.length, 11);
  assert.deepEqual(
    v4.map((m) => m.short),
    ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"],
  );
  assert.equal(v4[2].valueLabel, "None");
  assert.equal(v4[5].valueLabel, "Low");
  assert.equal(v4[8].valueLabel, "None");
});

test("the grid follows the selected version instead of always showing v3.0", () => {
  const finding = { cvss: { vector: V3, v2: { vector: V2 }, v4: { vector: V4 } } };

  assert.deepEqual(
    cvssMetricFingerprint(finding, "4.0").metrics.map((m) => m.short),
    ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"],
  );
  assert.deepEqual(
    cvssMetricFingerprint(finding, "2.0").metrics.map((m) => m.short),
    ["AV", "AC", "Au", "C", "I", "A"],
  );
  assert.deepEqual(
    cvssMetricFingerprint(finding, "3.0").metrics.map((m) => m.short),
    ["AV", "AC", "PR", "UI", "S", "C", "I", "A"],
  );
});

test("a value outside the version's vocabulary is dropped, not mislabelled", () => {
  // v3 "S:U" has no meaning in v2, and v2 has no Scope metric to hold it.
  const parsed = parseCvssVector("AV:N/AC:L/Au:N/S:U/C:P/I:N/A:N", "2.0");
  assert.deepEqual(
    parsed.map((m) => m.short),
    ["AV", "AC", "Au", "C", "I", "A"],
  );
});

test("a version with no stored vector falls back to v3.0 and says so", () => {
  // Findings scored before the derivation existed carry only the v3.0 vector.
  const legacy = { cvss: { vector: V3 } };
  const fingerprint = cvssMetricFingerprint(legacy, "4.0");
  assert.equal(fingerprint.versionId, "3.0");
  assert.deepEqual(
    fingerprint.metrics.map((m) => m.short),
    ["AV", "AC", "PR", "UI", "S", "C", "I", "A"],
  );
});

test("cvssVectorFor picks the right stored string and copes with a bare record", () => {
  const finding = { cvss: { vector: V3, v2: { vector: V2 }, v4: { vector: V4 } } };
  assert.equal(cvssVectorFor(finding, "3.0"), V3);
  assert.equal(cvssVectorFor(finding, "2.0"), V2);
  assert.equal(cvssVectorFor(finding, "4.0"), V4);
  assert.equal(cvssVectorFor({}, "3.0"), "");
  assert.equal(cvssVectorFor(undefined, "4.0"), "");
  assert.deepEqual(cvssMetricFingerprint({}, "3.0").metrics, []);
});
