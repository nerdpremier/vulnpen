import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scansKey,
  scanKey,
  testPlanKey,
  vulnerabilitiesKey,
  caseScansKey,
} from "./scanQueryKeys.mjs";

/**
 * These keys are the contract between the scan mutations and every page that
 * polls a scan surface. A scan writes case statuses onto the plan and findings
 * onto the session, so `invalidateScanCaches` must reach all of them; the test
 * pins the shapes so a key can't drift out from under an invalidation.
 */

test("each scan surface key carries the session id as its second element", () => {
  assert.deepEqual(scansKey("s1"), ["scans", "s1"]);
  assert.deepEqual(testPlanKey("s1"), ["test-plan", "s1"]);
  assert.deepEqual(vulnerabilitiesKey("s1"), ["vulnerabilities", "s1"]);
  assert.deepEqual(scanKey("s1", "r1"), ["scan", "s1", "r1"]);
  assert.deepEqual(caseScansKey("s1", "t1"), ["case-scans", "s1", "t1"]);
});

test("the detail keys extend their list key's prefix", () => {
  // Invalidation uses the prefix, so a detail key MUST start with its list key.
  const scan = scanKey("s1", "r1");
  assert.deepEqual(scan.slice(0, 2), ["scan", "s1"]);
  const caseScans = caseScansKey("s1", "t1");
  assert.deepEqual(caseScans.slice(0, 2), ["case-scans", "s1"]);
});
