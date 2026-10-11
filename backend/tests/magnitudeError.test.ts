import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserLlmErrorHint,
  browserReachabilityHint,
  isPostActionNavigationTimeout,
  isTransientBrowserLlmFailure,
} from "../src/utils/magnitudeError";

test("transient provider failures are classified for retry", () => {
  assert.ok(isTransientBrowserLlmFailure("BamlClientHttpError: Request failed with status code: 429"));
  assert.ok(isTransientBrowserLlmFailure("status code: 503 Service Unavailable"));
  assert.ok(isTransientBrowserLlmFailure("rate limit exceeded, too many requests"));
  assert.ok(!isTransientBrowserLlmFailure("status code: 404 Not Found"));
  assert.ok(!isTransientBrowserLlmFailure("X server missing"));
  assert.ok(!isTransientBrowserLlmFailure(""));
});

test("persistent LLM failures carry an actionable hint", () => {
  const gone = browserLlmErrorHint(
    "BamlClientHttpError: Request failed with status code: 404 Not Found",
    "Bunny",
  );
  assert.match(gone, /unavailable at its provider \(404\)/);
  assert.match(gone, /Settings → Models/);

  const limited = browserLlmErrorHint(
    "BamlClientHttpError: Request failed with status code: 429",
    "Bunny",
  );
  assert.match(limited, /rate limited/);
  assert.match(limited, /dedicated model/);

  // non-LLM errors stay untouched
  assert.equal(browserLlmErrorHint("X server missing", "Bunny"), "");
});

/**
 * The two timeout shapes, verbatim from the driver's call log.
 *
 * Both are "Timeout 15000ms exceeded" and they mean opposite things, which is
 * the whole reason the reachability hint needs to tell them apart: one is a
 * click that landed on a page whose follow-up navigation never committed, the
 * other is an address that never answered.
 */
const CLICK_NAVIGATION_TIMEOUT =
  "locator.click: Timeout 15000ms exceeded.\n" +
  "Call log:\n" +
  '  - waiting for locator("button:has-text(\\"Sign in\\")")\n' +
  "  -   click action done\n" +
  "  -   waiting for scheduled navigations to finish\n";

const GOTO_NAVIGATION_TIMEOUT =
  "page.goto: Timeout 15000ms exceeded.\n" +
  "Call log:\n" +
  '  - navigating to "http://zero.webappsecurity.com/login.html", waiting until "domcontentloaded"\n';

const ELEMENT_NEVER_APPEARED =
  "locator.waitFor: Timeout 15000ms exceeded.\n" +
  "Call log:\n" +
  '  - waiting for locator("#result") to be visible\n';

test("a delivered action whose navigation never settled is recognised", () => {
  assert.equal(isPostActionNavigationTimeout(CLICK_NAVIGATION_TIMEOUT), true);
  assert.equal(isPostActionNavigationTimeout(new Error(CLICK_NAVIGATION_TIMEOUT)), true);

  // An actionability timeout never reaches `action done`, because the action
  // never ran — so it must not be mistaken for a delivered one.
  assert.equal(isPostActionNavigationTimeout(ELEMENT_NEVER_APPEARED), false);
  assert.equal(isPostActionNavigationTimeout(GOTO_NAVIGATION_TIMEOUT), false);
  assert.equal(isPostActionNavigationTimeout("X server missing"), false);
  assert.equal(isPostActionNavigationTimeout(""), false);
  assert.equal(isPostActionNavigationTimeout(undefined), false);
});

test("the reachability hint fires for an address that never answered", () => {
  const goto = browserReachabilityHint(GOTO_NAVIGATION_TIMEOUT);
  assert.match(goto, /could not reach that address/);
  assert.match(goto, /Settings -> Browser Agent/);
  assert.match(goto, /VPN/);
  // The escape hatch, for a target the attack box itself cannot reach.
  assert.match(goto, /curl, ffuf, sqlmap/);

  assert.match(
    browserReachabilityHint(
      "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/",
    ),
    /could not reach that address/,
  );
  assert.match(
    browserReachabilityHint("NS_ERROR_UNKNOWN_HOST"),
    /could not reach that address/,
  );
  assert.match(
    browserReachabilityHint(
      "page.goto: net::ERR_NAME_NOT_RESOLVED at http://nope.invalid/",
    ),
    /could not reach that address/,
  );
});

test("the reachability hint ignores ERR_* that are not about reachability", () => {
  // Chromium raises ERR_* for plenty of things that have nothing to do with the
  // route to the target, and each of these used to collect the proxy/VPN advice.
  for (const message of [
    "page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1/",
    "page.goto: net::ERR_BLOCKED_BY_CLIENT at http://ads.example/",
    "page.goto: net::ERR_INVALID_URL at about:blank",
    "page.goto: net::ERR_ABORTED; maybe frame was detached?",
  ]) {
    assert.equal(browserReachabilityHint(message), "", message);
  }
});

test("the reachability hint stays quiet when the page was in fact reached", () => {
  // The regression: a click that landed, whose follow-up navigation never
  // committed, was reported as "Browser action failed" *and* told the operator
  // to check a proxy that had nothing to do with it.
  assert.equal(browserReachabilityHint(CLICK_NAVIGATION_TIMEOUT), "");

  // An element that never appeared is not a network problem either. A bare
  // "Timeout ... exceeded" used to be enough to blame the proxy here.
  assert.equal(browserReachabilityHint(ELEMENT_NEVER_APPEARED), "");

  // Unrelated failures keep their own hints.
  assert.equal(browserReachabilityHint("X server missing"), "");
  assert.equal(browserReachabilityHint("status code: 429"), "");
  assert.equal(browserReachabilityHint(""), "");
});
