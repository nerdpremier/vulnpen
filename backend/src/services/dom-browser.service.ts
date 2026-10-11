/**
 * DOM-driven browser execution.
 *
 * Magnitude's own agent loop (`agent.act(goal)`) locates every click target as a
 * *coordinate* through a small vision model (see magnitude-core's system prompt:
 * "a web agent powered by (1) a powerful LLM and (2) a small vision model
 * (Moondream)" — "Mouse movements require a target, which is located by
 * Moondream as a specific coordinate on the page"). That hard-wires the browser
 * agent to a vision-capable model and makes every action depend on a screen-space
 * guess that can miss.
 *
 * This module keeps the browser (Magnitude owns the warm Chromium, the proxy and
 * the Burp Browser profile) but drives it through Playwright's own DOM API on the
 * `page` the agent already exposes. Elements are addressed by role/label/text —
 * never by coordinate — so no vision model is involved anywhere in the path.
 *
 * That loop is called nowhere in this repository, and
 * `tests/visionFreeBrowser.test.ts` fails if a call to it reappears under `src/`
 * or `scripts/`. Magnitude is kept for the browser it owns, nothing more: the
 * assigned Browser Agent model builds its LLM client and is never asked a
 * question, so a text-only model is enough and no screenshot is ever read.
 */
// `patchright` is the Playwright distribution Magnitude itself launches the
// browser with (magnitude-core depends on `playwright: npm:patchright@^1.52.0`).
// Importing the type from here keeps the page handle typed without adding a
// second, unrelated Playwright to the dependency tree.
import type { Page } from "patchright";
import { isPostActionNavigationTimeout } from "../utils/magnitudeError";

/** One interactive element, as the model sees it. */
export interface DomElement {
  id: number;
  tag: string;
  role: string;
  name: string;
  value: string;
  ops: string[];
  disabled: boolean;
}

export interface DomSnapshot {
  url: string;
  title: string;
  elements: DomElement[];
  /** Rendered table: one line per element, what the model reads. */
  table: string;
  /** Visible text, trimmed — the page's content without its markup. */
  text: string;
}

/** Actions the DOM path can carry out. */
export type DomAction =
  | "snapshot"
  | "navigate"
  | "click"
  | "fill"
  | "select"
  | "press"
  | "check"
  | "wait_for"
  | "extract_text"
  | "back"
  | "forward"
  | "reload"
  | "scroll";

export interface DomActionRequest {
  action: DomAction;
  /** Element locator: either a snapshot id, or an explicit locator object. */
  element_id?: number;
  locator?: DomLocator;
  value?: string;
  url?: string;
  key?: string;
  timeout_ms?: number;
  /** For extract_text / snapshot: how much page text to return. */
  max_chars?: number;
  /** For scroll. */
  direction?: "up" | "down";
  amount?: number;
}

/** How to find an element without coordinates. */
export interface DomLocator {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  test_id?: string;
  css?: string;
  nth?: number;
}

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 15_000;
const SNAPSHOT_ELEMENT_LIMIT = 120;

/**
 * How long the page is given to finish reacting before it is read.
 *
 * A click returns as soon as the event is dispatched, which is *before* the
 * request it started comes back and before most frameworks paint the result. The
 * next read then describes the state the action was meant to replace, and the
 * model sees its own action as having done nothing — so it retries, or reports a
 * failure that never happened. The wait is a quiet window, not a fixed sleep:
 * it ends as soon as the page stops changing.
 */
const SETTLE_QUIET_MS = 400;
const SETTLE_BUDGET_MS = 5_000;

/** Actions that can change the page, and so need settling and verification. */
const MUTATING_ACTIONS = new Set<DomAction>([
  "navigate",
  "back",
  "forward",
  "reload",
  "click",
  "check",
  "fill",
  "select",
  "press",
]);

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * A cheap fingerprint of what the page currently shows.
 *
 * Used to answer "did that action do anything?" without a screenshot and without
 * a second full snapshot. URL, length and a digest of the markup together catch
 * a navigation, an added row, a toggled class and a changed message, which is
 * everything a click is expected to produce.
 */
async function pageRevision(page: Page): Promise<string> {
  await ensurePageHelpers(page);
  return page.evaluate(() => {
    const html = document.documentElement ? document.documentElement.outerHTML : "";
    let hash = 0;
    for (let i = 0; i < html.length; i += 1) {
      hash = (hash * 31 + html.charCodeAt(i)) | 0;
    }
    return `${location.href}#${html.length}#${hash}`;
  });
}

/**
 * Wait until the page has stopped reacting, bounded by `budgetMs`.
 *
 * Two things are waited on, because either alone misses a common case: in-flight
 * requests (a click that submits a form has not finished when the click returns)
 * and DOM mutations (a framework paints a tick later, and a slow render would
 * otherwise read as "nothing happened").
 *
 * Every wait is bounded and every failure is swallowed: a page that polls
 * forever never reaches network idle, and refusing to proceed would turn a slow
 * page into a broken run. Settling is best-effort by design — the verification
 * below is what reports honestly when it could not.
 *
 * What it does not cover, stated plainly: a page that changes with no request
 * and no mutation for longer than the quiet window (a bare `setTimeout` of a few
 * seconds). No settle heuristic can see that coming, and waiting long enough to
 * catch it would add that delay to every action on every page. A request-driven
 * update is covered by the network-idle wait, which is the case real pages
 * produce.
 */
export async function settlePage(
  page: Page,
  budgetMs: number = SETTLE_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;

  await page.waitForLoadState("networkidle", { timeout: budgetMs }).catch(() => {});

  const remaining = deadline - Date.now();
  if (remaining <= 0) return;

  // The evaluated code below is transpiled with `keepNames`, so it may contain
  // `__name(...)` calls that only resolve if the page carries the shim. The
  // action that just ran may have navigated, which is why the shim is installed
  // through addInitScript (see ensurePageHelpers) and re-asserted here.
  await ensurePageHelpers(page);

  const quietMs = Math.min(SETTLE_QUIET_MS, remaining);
  await Promise.race([
    page
      .evaluate(
        (window: number) =>
          new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const stop = () => {
              observer.disconnect();
              clearTimeout(timer);
              resolve();
            };
            const observer = new MutationObserver(() => {
              clearTimeout(timer);
              timer = setTimeout(stop, window);
            });
            timer = setTimeout(stop, window);
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          }),
        quietMs,
      )
      .catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, remaining)),
  ]);
}

/**
 * Report what the action actually did, not just that it was dispatched.
 *
 * "clicked Sign in" is a statement about the *attempt*: the element was found and
 * the event was sent. It says nothing about whether anything happened, and a
 * no-op click reported as success is worse than an error — the model builds on
 * it, and the failure only shows up several steps later as an unexplained dead
 * end. So each action is checked against the page it was supposed to change.
 */
async function verifyAction(
  page: Page,
  req: DomActionRequest,
  elements: DomElement[],
  line: string,
  before: string,
): Promise<string> {
  try {
    switch (req.action) {
      case "fill": {
        const { locator, label } = await locatorFrom(page, req, elements);
        const actual = await locator.inputValue({ timeout: 2_000 }).catch(() => null);
        if (actual === null || actual === req.value) return line;
        return `${line} — but ${label} now reads "${truncate(actual)}", so the page did not keep the value.`;
      }
      case "select": {
        const { locator, label } = await locatorFrom(page, req, elements);
        const actual = await locator.inputValue({ timeout: 2_000 }).catch(() => null);
        if (actual === null || actual === req.value) return line;
        return `${line} — but ${label} now reads "${truncate(actual)}".`;
      }
      case "check": {
        const { locator, label } = await locatorFrom(page, req, elements);
        const now = await locator.isChecked({ timeout: 2_000 }).catch(() => null);
        if (now === null) return line;
        const wanted = line.startsWith("checked");
        if (now === wanted) return line;
        return `${line} — but ${label} is now ${now ? "checked" : "unchecked"}.`;
      }
      default: {
        // click, press, and the navigations: the honest question is whether the
        // page moved at all.
        const after = await pageRevision(page).catch(() => "");
        if (!before || !after || after !== before) return line;
        return (
          `${line} — but the page did not change. The action had no visible effect; ` +
          "check that the element is the right one, or look for a validation message on the page."
        );
      }
    }
  } catch {
    // Verification is a courtesy on top of a successful action; never let it turn
    // a working action into a failed one.
    return line;
  }
}

/**
 * Roles `page.getByRole` accepts.
 *
 * `roleOf` falls back to the tag name for anything it does not recognise — a
 * `<div tabindex>` is reported as `div`, a `<label>` as `label` — and
 * `getByRole("div")` throws. That surfaced as "the agent cannot click the
 * element it just read from its own snapshot", so anything outside this set is
 * addressed by text or tag instead of by role.
 */
const ARIA_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "menuitemcheckbox",
  "menuitemradio",
  "heading",
  "img",
  "list",
  "listitem",
  "table",
  "cell",
  "row",
  "dialog",
  "alert",
  "status",
  "progressbar",
  "slider",
  "spinbutton",
  "separator",
  "group",
  "navigation",
  "form",
  "search",
  "banner",
  "main",
  "region",
]);

/**
 * The role to address an element by, or null when there is no usable one.
 *
 * Exported because it is the one rule that decides whether a role the model
 * sends (or one a snapshot reported) can be turned into a locator at all.
 */
export function roleForLocator(role: string): string | null {
  const normalized = (role || "").toLowerCase().trim();
  return normalized && ARIA_ROLES.has(normalized) ? normalized : null;
}

/**
 * Let the page tolerate the helpers a transpiler injects.
 *
 * A transpiler that preserves function names — esbuild's `keepNames`, which tsx
 * enables — rewrites every *named* function inside the collector to
 * `__name(fn, "fn")`. Playwright serializes an evaluated function's source and
 * runs it in the page, where that helper does not exist, so the collector dies
 * with "ReferenceError: __name is not defined" before it reads a single control.
 *
 * The compiled server never hits this (tsc injects no helpers) and neither does
 * a plain `node dist/server.js`, which is why it stayed hidden: every tsx-run
 * script and test does hit it, including the browser checks. The shim is the
 * identity function the wrapper is calling.
 *
 * Re-asserted before every evaluated block, deliberately. This used to be
 * installed once per page and remembered in a WeakSet, which is wrong in the
 * only case that matters: the shim lives on the window, a navigation replaces
 * the window, and an agent navigates between steps — so the collector worked
 * until the first navigation and then died on the next read. `addInitScript`
 * would have been the natural fix, but it never runs on this browser (measured:
 * a marker set through it is absent even on the very first load), so the shim
 * has to be re-installed by hand. One extra round trip per read is the cost of
 * being right.
 *
 * The install itself uses only anonymous arrows, so it works even in a document
 * that does not have the shim yet — which is what breaks the cycle.
 */
async function ensurePageHelpers(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      if (typeof w.__name !== "function") w.__name = (value: unknown) => value;
    })
    .catch(() => {});
}

/**
 * Read the interactive elements of the current page in one pass.
 *
 * Runs in the page, not in Node: one round trip returns every control with the
 * label a human would read, instead of serialising the accessibility tree.
 */
async function collectElements(page: Page): Promise<DomElement[]> {
  await ensurePageHelpers(page);
  return page.evaluate((limit: number) => {
    const CLICK_ROLES = new Set([
      "button",
      "link",
      "menuitem",
      "tab",
      "option",
      "checkbox",
      "radio",
      "switch",
      "menuitemcheckbox",
      "menuitemradio",
    ]);
    // Only these are "roles" in the sense the element list uses; everything else
    // falls back to the tag name so the table stays readable.
    const SELECTOR = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "label",
      "option",
      "[role=button]",
      "[role=link]",
      "[role=menuitem]",
      "[role=tab]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=switch]",
      "[role=combobox]",
      "[role=textbox]",
      "[role=searchbox]",
      "[contenteditable=true]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const seen = new Set<Element>();
    const out: any[] = [];
    let id = 0;

    const isVisible = (el: Element): boolean => {
      const anyEl = el as HTMLElement;
      if (!anyEl.isConnected) return false;
      const style = window.getComputedStyle(anyEl);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (parseFloat(style.opacity || "1") <= 0.02) return false;
      const rect = anyEl.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      return true;
    };

    const roleOf = (el: Element): string => {
      const explicit = (el.getAttribute("role") || "").toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input") {
        if (type === "checkbox" || type === "radio") return type;
        if (type === "submit" || type === "button" || type === "reset") return "button";
        return "textbox";
      }
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "summary") return "button";
      if (tag === "option") return "option";
      return tag;
    };

    /** The name a screen reader (or a human) would use for this control. */
    const nameOf = (el: Element): string => {
      const attr = (n: string) => {
        const v = el.getAttribute(n);
        return v && v.trim() ? v.trim() : "";
      };
      const aria = attr("aria-label");
      if (aria) return aria;

      const labelledBy = attr("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((refId) => document.getElementById(refId)?.textContent?.trim() || "")
          .filter(Boolean);
        if (parts.length) return parts.join(" ");
      }

      // A wrapping or `for`-linked <label>.
      const elId = el.getAttribute("id");
      if (elId) {
        const label = document.querySelector(`label[for="${CSS.escape(elId)}"]`);
        const t = label?.textContent?.trim();
        if (t) return t;
      }
      const closestLabel = el.closest("label");
      const closestText = closestLabel?.textContent?.trim();
      if (closestText) return closestText.slice(0, 120);

      const title = attr("title");
      if (title) return title;
      const placeholder = attr("placeholder");
      if (placeholder) return placeholder;
      const alt = attr("alt");
      if (alt) return alt;
      const value = attr("value");
      if (value) return value;

      const text = (el.textContent || "").trim();
      if (text) return text.slice(0, 120);
      return "";
    };

    const valueOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const v = (el as HTMLInputElement).value || "";
        // Never echo a password back into the transcript.
        if ((el.getAttribute("type") || "").toLowerCase() === "password") {
          return v ? "••••••" : "";
        }
        return v.slice(0, 120);
      }
      if (tag === "select") {
        const sel = (el as HTMLSelectElement).selectedOptions[0];
        return sel ? (sel.textContent || "").trim().slice(0, 120) : "";
      }
      return "";
    };

    const opsOf = (el: Element, role: string): string[] => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const ops: string[] = [];
      const clickable =
        CLICK_ROLES.has(role) ||
        tag === "a" ||
        tag === "button" ||
        tag === "summary" ||
        tag === "label" ||
        type === "checkbox" ||
        type === "radio" ||
        type === "submit";
      if (clickable) {
        ops.push(
          type === "checkbox" || type === "radio" ? "check" : "click",
        );
      }
      // Only a field that holds text can be filled. `tag === "input"` alone also
      // covers checkboxes, radios and submit buttons, which then advertised an
      // action they cannot carry out - and an action the element refuses is a
      // turn the model spends discovering that.
      const textInput =
        tag === "input" &&
        ![
          "checkbox",
          "radio",
          "submit",
          "button",
          "reset",
          "file",
          "image",
          "range",
          "color",
          "hidden",
        ].includes(type);
      if (
        textInput ||
        tag === "textarea" ||
        role === "textbox" ||
        role === "searchbox"
      ) {
        ops.push("fill");
      }
      if (tag === "select" || role === "combobox" || role === "listbox") {
        if (!ops.includes("select")) ops.push("select");
      }
      return ops;
    };

    const collected: { el: Element; role: string; ops: string[] }[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;

      const role = roleOf(el);
      const ops = opsOf(el, role);
      if (!ops.length) continue;

      collected.push({ el, role, ops });
    }

    // A <label> whose control is already listed is a second row for the same
    // thing - "label Username — click" beside "textbox Username — fill" - so the
    // model holds two ids for one field and can act on the wrong one, which the
    // DOM path then refuses. A label survives only when it is the sole visible
    // control, which is how a custom checkbox is built over a hidden input.
    const shadowedLabels = new Set<Element>();
    for (const { el } of collected) {
      if (el.tagName.toLowerCase() !== "label") continue;
      const forId = el.getAttribute("for");
      const target = forId
        ? document.getElementById(forId)
        : el.querySelector("input,select,textarea");
      if (target && seen.has(target)) shadowedLabels.add(el);
    }

    for (const { el, role, ops } of collected) {
      if (shadowedLabels.has(el)) continue;

      id += 1;
      const anyEl = el as HTMLInputElement;
      out.push({
        id,
        tag: el.tagName.toLowerCase(),
        role,
        name: nameOf(el),
        value: valueOf(el),
        ops,
        disabled: Boolean(anyEl.disabled),
      });

      if (out.length >= limit) break;
    }

    return out;
  }, SNAPSHOT_ELEMENT_LIMIT);
}

/** Visible text of the page, with script/style noise removed. */
async function collectText(page: Page, maxChars: number): Promise<string> {
  await ensurePageHelpers(page);
  const raw = await page.evaluate(() => {
    const body = document.body;
    if (!body) return "";
    const clone = body.cloneNode(true) as HTMLElement;
    for (const el of Array.from(
      clone.querySelectorAll("script,style,noscript,svg,template"),
    )) {
      el.remove();
    }
    return (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n");
  });
  const text = raw.trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}

/** Render the element list as the compact table the model reads. */
function renderTable(elements: DomElement[]): string {
  if (!elements.length) return "(no interactive elements found)";
  return elements
    .map((e) => {
      const role = e.role.padEnd(10).slice(0, 10);
      const ops = e.ops.join("/");
      const name = e.name.replace(/\s+/g, " ").slice(0, 70) || "(unnamed)";
      const value = e.value ? ` = "${e.value.replace(/\s+/g, " ").slice(0, 40)}"` : "";
      const dis = e.disabled ? " [disabled]" : "";
      return `[${e.id}] ${role} ${name}${value} — ${ops}${dis}`;
    })
    .join("\n");
}

/** Take a full snapshot: indexed controls plus visible text. */
export async function snapshotPage(
  page: Page,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<DomSnapshot> {
  const [elements, text] = await Promise.all([
    collectElements(page),
    collectText(page, maxChars),
  ]);
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    elements,
    table: renderTable(elements),
    text,
  };
}

/** One way to find an element, tried in priority order. */
interface LocatorCandidate {
  build: () => ReturnType<Page["locator"]>;
  label: string;
}

/**
 * Return the first candidate that actually matches something.
 *
 * Tried in order and evaluated against the live page rather than unioned with
 * `.or()`, because `.or()` resolves in document order: a loose candidate would
 * then win over the precise one and click a container instead of the control.
 * A candidate the page cannot evaluate at all (an unknown role) is skipped.
 */
async function resolveCandidate(
  page: Page,
  candidates: LocatorCandidate[],
): Promise<{ locator: ReturnType<Page["locator"]>; label: string }> {
  for (const candidate of candidates) {
    try {
      const locator = candidate.build();
      if ((await locator.count()) > 0) return { locator, label: candidate.label };
    } catch {
      // Skip it; a later candidate may still address the element.
    }
  }
  throw new Error(
    `No element matched ${candidates.map((c) => c.label).join(" or ")}. ` +
      "Take a new snapshot — the page may have changed since it was read.",
  );
}

/**
 * Resolve a locator to a Playwright `Locator`.
 *
 * A snapshot id is not stable across navigation, so the caller passes the element
 * list from the snapshot it is acting on and we rebuild the locator from that
 * element's own role/name — by the time the action runs the ids may have shifted.
 */
async function locatorFrom(
  page: Page,
  req: DomActionRequest,
  elements: DomElement[],
): Promise<{ locator: ReturnType<Page["locator"]>; label: string }> {
  const explicit = req.locator;
  if (explicit) {
    const candidates: LocatorCandidate[] = [];
    if (explicit.role) {
      if (!roleForLocator(explicit.role)) {
        throw new Error(
          `"${explicit.role}" is not an ARIA role Playwright can address. Use one of: ` +
            `${Array.from(ARIA_ROLES).sort().join(", ")} — or locate by label, text, ` +
            "placeholder, test_id or css instead.",
        );
      }
      const role = explicit.role;
      candidates.push({
        build: () =>
          page.getByRole(role as any, { name: explicit.name, exact: false }),
        label: JSON.stringify(explicit),
      });
    } else if (explicit.label) {
      candidates.push({
        build: () => page.getByLabel(explicit.label!, { exact: false }),
        label: JSON.stringify(explicit),
      });
    } else if (explicit.placeholder) {
      candidates.push({
        build: () => page.getByPlaceholder(explicit.placeholder!, { exact: false }),
        label: JSON.stringify(explicit),
      });
    } else if (explicit.test_id) {
      candidates.push({
        build: () => page.getByTestId(explicit.test_id!),
        label: JSON.stringify(explicit),
      });
    } else if (explicit.text) {
      candidates.push({
        build: () => page.getByText(explicit.text!, { exact: false }),
        label: JSON.stringify(explicit),
      });
    } else if (explicit.css) {
      candidates.push({
        build: () => page.locator(explicit.css!),
        label: JSON.stringify(explicit),
      });
    } else {
      throw new Error(
        "A locator needs one of: role, label, placeholder, test_id, text, css",
      );
    }
    const nth = explicit.nth ?? 0;
    const resolved = await resolveCandidate(page, candidates);
    return {
      locator: nth ? resolved.locator.nth(nth) : resolved.locator.first(),
      label: resolved.label,
    };
  }

  if (typeof req.element_id === "number") {
    const el = elements.find((e) => e.id === req.element_id);
    if (!el) {
      throw new Error(
        `No element [${req.element_id}] in the snapshot. Take a new snapshot — ids are per-page-state.`,
      );
    }
    // Rebuild from the element's own identity, not its id: the id is only valid
    // for the snapshot it came from, and the page may have re-rendered since.
    //
    // The name in the table is the label a human would read, which is not always
    // the accessible name Playwright computes for that role — an input whose name
    // came from its placeholder, a button whose name came from its value. So the
    // candidates are tried in order of precision rather than assuming the exact
    // accessible name matches.
    const role = roleForLocator(el.role);
    const candidates: LocatorCandidate[] = [];
    if (el.name && role) {
      candidates.push({
        build: () => page.getByRole(role as any, { name: el.name, exact: true }),
        label: `[${el.id}] ${el.role} "${el.name}"`,
      });
      candidates.push({
        build: () => page.getByRole(role as any, { name: el.name, exact: false }),
        label: `[${el.id}] ${el.role} "${el.name}"`,
      });
    }
    if (el.name && (el.role === "textbox" || el.role === "searchbox")) {
      candidates.push({
        build: () => page.getByPlaceholder(el.name, { exact: false }),
        label: `[${el.id}] placeholder "${el.name}"`,
      });
      candidates.push({
        build: () => page.getByLabel(el.name, { exact: false }),
        label: `[${el.id}] label "${el.name}"`,
      });
    }
    if (el.name) {
      candidates.push({
        build: () => page.getByText(el.name, { exact: false }),
        label: `[${el.id}] text "${el.name}"`,
      });
    }
    candidates.push({
      build: () => page.locator(el.tag),
      label: `[${el.id}] ${el.tag}`,
    });

    const resolved = await resolveCandidate(page, candidates);
    return { locator: resolved.locator.first(), label: resolved.label };
  }

  throw new Error("An element is required: pass element_id or locator.");
}

/**
 * Refuse an action the element cannot carry out, before it becomes a timeout.
 *
 * A snapshot already reports what each control offers (`ops`), so acting against
 * that list costs nothing and removes a whole class of stuck runs: filling a
 * button or selecting on a text box can only be discovered by waiting out a
 * locator timeout, and a run that spends its budget on timeouts is what makes the
 * browser look hung. `click` is deliberately always allowed — focusing a field,
 * submitting through a label and toggling a checkbox are all clicks.
 */
export function unsupportedElementAction(
  el: DomElement,
  action: DomAction,
): string | null {
  const required: Partial<Record<DomAction, string>> = {
    fill: "fill",
    select: "select",
    check: "check",
  };
  const op = required[action];
  if (!op || el.ops.includes(op)) return null;
  return (
    `Element [${el.id}] ${el.role} "${el.name}" does not support ${action} — it offers ` +
    `${el.ops.length ? el.ops.join("/") : "no actions"}. Take a new snapshot and pick an ` +
    "element that offers it."
  );
}

/**
 * Run one action against the page. Returns a human-readable result line.
 *
 * Actions that can change the page are settled and then verified: the line says
 * what the page did, not merely that the event was dispatched. See settlePage
 * and verifyAction.
 *
 * An action that was delivered but whose follow-up navigation never finished is
 * reported as exactly that, not as a failure, and the stuck load is cancelled so
 * the page stays readable — see deliveredWithoutSettling and stopStuckLoading.
 */
export async function runDomAction(
  page: Page,
  req: DomActionRequest,
  elements: DomElement[],
): Promise<string> {
  const timeout = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  if (typeof req.element_id === "number") {
    const el = elements.find((e) => e.id === req.element_id);
    if (el) {
      const problem = unsupportedElementAction(el, req.action);
      if (problem) throw new Error(problem);
    }
  }

  const mutating = MUTATING_ACTIONS.has(req.action);
  // Captured before the action: the only way to tell afterwards whether the page
  // moved. Reading it can fail on a page that is mid-navigation, which is not
  // itself a problem — verification then simply stays quiet.
  const before = mutating ? await pageRevision(page).catch(() => "") : "";
  const beforeUrl = page.url();

  let line: string;
  try {
    line = await performDomAction(page, req, elements, timeout);
  } catch (error) {
    // The action was carried out and only the navigation it started never
    // finished. See isPostActionNavigationTimeout: an actionability timeout —
    // the element was never found — does not carry the driver's `action done`
    // line and still propagates as a failure, which is what it is.
    if (!mutating || !isPostActionNavigationTimeout(error)) throw error;
    // No settlePage on this path, deliberately. The page is waiting on the
    // navigation that just timed out, so every further wait is the wait that
    // already failed — measured at tens of seconds of dead time before the
    // caller's read could even start.
    await stopStuckLoading(page);
    return deliveredWithoutSettling(page, req, beforeUrl, timeout);
  }

  if (!mutating) return line;

  // Settle before anything reads the page, including the caller's own snapshot.
  await settlePage(page, Math.min(SETTLE_BUDGET_MS, timeout));
  return verifyAction(page, req, elements, line, before);
}

/**
 * Clear a navigation the page is still waiting on.
 *
 * A click that starts a request the server never answers leaves the frame
 * waiting for a navigation that will never commit, and *every* later read that
 * needs the frame's execution context blocks behind it — `page.title()`,
 * `page.evaluate()`, a snapshot. Measured on the real attack box, against a form
 * that posts to a port which accepts and then says nothing: after the click
 * timed out, all of those hung, `page.url()` alone still answered (it needs no
 * context), and the page stayed that way indefinitely.
 *
 * `Page.stopLoading` over CDP releases it in ~100ms and *keeps the document*, so
 * the DOM the agent was working on is still there afterwards. The alternatives
 * were measured on the same page: `page.goto()` recovers too but throws the page
 * away, and `page.reload()` recovers only as a side effect of its own abort,
 * while reporting `net::ERR_ABORTED`.
 *
 * Best-effort by design: if the session cannot be opened, the page is no worse
 * off than it was, and the caller still reports the action honestly.
 */
async function stopStuckLoading(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Page.stopLoading");
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    // The report below is true with or without the recovery.
  }
}

/**
 * The line for an action that was carried out but whose follow-up navigation
 * never finished.
 *
 * It says what is known rather than what went wrong: the event was delivered,
 * the page is where it is, and the request may still be in flight. Saying "the
 * action failed" would be wrong twice over — the click did happen, and the model
 * is invited to send it again, which on a form is a second submission.
 *
 * No `verifyAction` call: its "the page did not change" verdict would be
 * misleading here, because the reason the page looks unchanged is already known.
 */
function deliveredWithoutSettling(
  page: Page,
  req: DomActionRequest,
  beforeUrl: string,
  timeout: number,
): string {
  const now = page.url();
  const where =
    now && now !== beforeUrl
      ? `it moved the page to ${now}, but that page never finished loading`
      : `the page is still ${now || beforeUrl || "(unknown)"}, so the navigation never committed`;

  return (
    `${req.action} was delivered, but ${where} within ${timeout}ms. The load it started has ` +
    "been cancelled so the page can be read again — the address did answer, so this is not a " +
    "routing problem, and the request may still be running on the server. Do not repeat the " +
    "action: a form it submitted would be submitted twice. Read the page below and decide from " +
    "what is there."
  );
}

/** The action itself. Split out so runDomAction can wrap it in settle + verify. */
async function performDomAction(
  page: Page,
  req: DomActionRequest,
  elements: DomElement[],
  timeout: number,
): Promise<string> {
  switch (req.action) {
    case "navigate": {
      if (!req.url) throw new Error("navigate requires a url");
      await page.goto(req.url, { waitUntil: "domcontentloaded", timeout });
      return `navigated to ${page.url()}`;
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded", timeout });
      return `back to ${page.url()}`;
    }
    case "forward": {
      await page.goForward({ waitUntil: "domcontentloaded", timeout });
      return `forward to ${page.url()}`;
    }
    case "reload": {
      await page.reload({ waitUntil: "domcontentloaded", timeout });
      return `reloaded ${page.url()}`;
    }
    case "click": {
      const { locator, label } = await locatorFrom(page, req, elements);
      await locator.click({ timeout });
      return `clicked ${label}`;
    }
    case "check": {
      const { locator, label } = await locatorFrom(page, req, elements);
      const checked = await locator.isChecked().catch(() => false);
      if (checked) {
        await locator.uncheck({ timeout });
        return `unchecked ${label}`;
      }
      await locator.check({ timeout });
      return `checked ${label}`;
    }
    case "fill": {
      if (typeof req.value !== "string") throw new Error("fill requires a value");
      const { locator, label } = await locatorFrom(page, req, elements);
      await locator.fill(req.value, { timeout });
      return `filled ${label} with "${req.value.slice(0, 60)}"`;
    }
    case "select": {
      if (typeof req.value !== "string") throw new Error("select requires a value");
      const { locator, label } = await locatorFrom(page, req, elements);
      await locator.selectOption({ label: req.value }, { timeout }).catch(async () => {
        await locator.selectOption(req.value as string, { timeout });
      });
      return `selected "${req.value}" in ${label}`;
    }
    case "press": {
      const key = req.key || "Enter";
      if (typeof req.element_id === "number" || req.locator) {
        const { locator, label } = await locatorFrom(page, req, elements);
        await locator.press(key, { timeout });
        return `pressed ${key} on ${label}`;
      }
      await page.keyboard.press(key);
      return `pressed ${key}`;
    }
    case "wait_for": {
      if (req.element_id === undefined && !req.locator && !req.value) {
        throw new Error("wait_for needs an element_id, locator, or text value");
      }
      if (req.value && req.element_id === undefined && !req.locator) {
        await page.getByText(req.value, { exact: false }).first().waitFor({ timeout });
        return `text "${req.value}" appeared`;
      }
      const { locator, label } = await locatorFrom(page, req, elements);
      await locator.waitFor({ state: "visible", timeout });
      return `${label} is visible`;
    }
    case "extract_text": {
      const text = await collectText(page, req.max_chars ?? DEFAULT_MAX_CHARS);
      return text || "(page has no visible text)";
    }
    case "scroll": {
      const amount = req.amount ?? 800;
      const delta = req.direction === "up" ? -amount : amount;
      await page.mouse.wheel(0, delta);
      return `scrolled ${req.direction ?? "down"} by ${amount}px`;
    }
    case "snapshot": {
      return "snapshot does not change the page";
    }
    default:
      throw new Error(`Unsupported action: ${req.action}`);
  }
}

/**
 * True when the page still has a live document. Magnitude's browser is shared and
 * long-lived, so a crash or an external close would otherwise surface as a
 * confusing locator timeout on the next call.
 */
export function pageIsAlive(page: Page): boolean {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}
