import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoTrustBurpCa } from "../src/services/burp-ca.service";

// The shape getBurpCaStatus() reports once the proxy URL is set and the
// certificate downloaded, but before the profile has accepted it.
const pending = {
  proxyConfigured: true,
  certificateAvailable: true,
  trusted: false,
  needsRefresh: false,
  message: "",
};

test("shouldAutoTrustBurpCa picks up a CA the profile has not accepted yet", () => {
  assert.equal(shouldAutoTrustBurpCa({ ...pending }), true);
  // Burp restarted and rotated its CA: still untrusted, so it is picked up too.
  assert.equal(shouldAutoTrustBurpCa({ ...pending, needsRefresh: true }), true);
});

test("shouldAutoTrustBurpCa leaves a profile that already trusts the CA alone", () => {
  assert.equal(shouldAutoTrustBurpCa({ ...pending, trusted: true }), false);
});

test("shouldAutoTrustBurpCa needs both the proxy URL and a fetched certificate", () => {
  // No proxy URL, so there is nowhere to fetch the certificate from.
  assert.equal(
    shouldAutoTrustBurpCa({ ...pending, proxyConfigured: false, certificateAvailable: false }),
    false,
  );
  // Burp unreachable, so the certificate could not be fetched - and
  // needsRefresh on its own is not enough, the new CA has to be fetched first.
  assert.equal(
    shouldAutoTrustBurpCa({ ...pending, certificateAvailable: false, needsRefresh: true }),
    false,
  );
});
