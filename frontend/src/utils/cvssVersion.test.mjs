import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CVSS_VERSION_IDS,
  DEFAULT_CVSS_VERSION,
  cvssBandsFor,
  cvssScoreFor,
  cvssSeverityWord,
  cvssVersionFor,
  cvssVersionLabel,
  cvssVersionsFor,
  isCvssVersionId,
  readCvssVersion,
  subscribeCvssVersion,
  writeCvssVersion,
} from "./cvssVersion.mjs";

/* The three views one finding carries: v3.0 is the rating the system computed,
   v2.0 and v4.0 are the same finding derived server-side. */
const SCORED = {
  score: 5.3,
  vector: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
  v2: { score: 5.0, vector: "AV:N/AC:L/Au:N/C:P/I:N/A:N" },
  v4: { score: 6.9, vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N" },
};
const LEGACY = { score: 5.3, vector: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N" };

test("versions read newest first, and the default is the computed v3.0", () => {
  assert.deepEqual(CVSS_VERSION_IDS, ["4.0", "3.0", "2.0"]);
  assert.equal(DEFAULT_CVSS_VERSION, "3.0");
});

test("the version ids are the only ones the reader accepts", () => {
  assert.equal(isCvssVersionId("4.0"), true);
  assert.equal(isCvssVersionId(3), false); // numbers are not ids
  assert.equal(isCvssVersionId("3.1"), false);
  assert.equal(isCvssVersionId(undefined), false);
});

test("a fully scored finding reads its score in each version", () => {
  assert.equal(cvssScoreFor({ cvss: SCORED }, "4.0"), 6.9);
  assert.equal(cvssScoreFor({ cvss: SCORED }, "3.0"), 5.3);
  assert.equal(cvssScoreFor({ cvss: SCORED }, "2.0"), 5.0);
  assert.equal(cvssVersionLabel("4.0"), "CVSS v4.0");
});

test("a finding with no stored version falls back to the newest it has", () => {
  // Recorded before the v4/v2 derivation existed: only the v3.0 view is stored.
  const chosen = cvssVersionFor({ cvss: LEGACY }, "4.0");
  assert.equal(chosen.id, "3.0");
  assert.equal(chosen.score, 5.3);
  // Asking for a version the finding carries still wins over the fallback.
  assert.equal(cvssVersionFor({ cvss: SCORED }, "2.0").id, "2.0");
});

test("a finding with no score at all reads as unrated in every version", () => {
  assert.equal(cvssScoreFor({ cvss: {} }, "4.0"), null);
  assert.equal(cvssScoreFor({}, "3.0"), null);
  assert.equal(cvssScoreFor(undefined, "3.0"), null);
  assert.deepEqual(cvssVersionsFor({}), []);
  assert.equal(cvssVersionFor({ cvss: {} }, "4.0"), null);
});

test("cvssVersionsFor lists only the versions the finding is scored in", () => {
  assert.deepEqual(
    cvssVersionsFor({ cvss: SCORED }).map((v) => v.id),
    ["4.0", "3.0", "2.0"],
  );
  assert.deepEqual(cvssVersionsFor({ cvss: LEGACY }).map((v) => v.id), ["3.0"]);
});

test("v2.0 stops at High and has no None band", () => {
  assert.deepEqual(cvssBandsFor("2.0").map((b) => b.key), ["low", "medium", "high"]);
  assert.deepEqual(
    cvssBandsFor("3.0").map((b) => b.key),
    ["none", "low", "medium", "high", "critical"],
  );
  assert.deepEqual(cvssBandsFor("4.0").map((b) => b.key), cvssBandsFor("3.0").map((b) => b.key));
  // 9.8 is Critical under v3.0 but High under v2.0 — the band sets differ.
  assert.equal(cvssSeverityWord(9.8, "3.0"), "critical");
  assert.equal(cvssSeverityWord(9.8, "2.0"), "high");
  assert.equal(cvssSeverityWord(0, "3.0"), "info");
});

test("the score's severity word tracks the version's own bands", () => {
  assert.equal(cvssSeverityWord(6.9, "4.0"), "medium");
  assert.equal(cvssSeverityWord(5.3, "3.0"), "medium");
  assert.equal(cvssSeverityWord(5.0, "2.0"), "medium");
  assert.equal(cvssSeverityWord(NaN, "3.0"), "info");
});

/* A tiny in-memory stand-in for localStorage + the window event target, so the
   persistence and the cross-surface event are exercised without a DOM. */
function fakeStore() {
  const items = new Map();
  const listeners = new Set();
  return {
    storage: {
      getItem: (k) => (items.has(k) ? items.get(k) : null),
      setItem: (k, v) => items.set(k, String(v)),
    },
    target: {
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
      dispatchEvent: (event) => {
        listeners.forEach((fn) => fn(event));
        return true;
      },
    },
    fire: (versionId) => listeners.forEach((fn) => fn({ detail: { versionId } })),
  };
}

test("the choice persists, announces itself, and unsubscribes", () => {
  const { storage, target } = fakeStore();
  const seen = [];
  const off = subscribeCvssVersion((e) => seen.push(e.detail.versionId), target);

  assert.equal(readCvssVersion(storage), "3.0"); // nothing stored: the default
  writeCvssVersion("2.0", { storage, target });

  assert.equal(readCvssVersion(storage), "2.0");
  assert.deepEqual(seen, ["2.0"]);

  off();
  writeCvssVersion("3.0", { storage, target });
  assert.equal(readCvssVersion(storage), "3.0");
  assert.deepEqual(seen, ["2.0"]); // no longer listening
});

test("a garbage or unknown stored value reads as the default", () => {
  const { storage, target } = fakeStore();
  writeCvssVersion("9.9", { storage, target }); // rejected: not a version id
  assert.equal(readCvssVersion(storage), "3.0");
  storage.setItem("cvss-version", "not-a-version");
  assert.equal(readCvssVersion(storage), "3.0");
});
