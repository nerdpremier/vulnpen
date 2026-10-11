/**
 * Live check for the DOM-driven browser path.
 *
 * Proves what the old check could not: that click / fill / select work by
 * addressing elements through the DOM, with no screenshot anywhere in the loop
 * and no vision model involved. It drives a real Chromium over a local page
 * (no network, no provider calls), so it is cheap and repeatable.
 *
 * Run: npx tsx scripts/browser-dom-check.ts
 */
import { loadConfig } from "../src/utils/loadConfig";
import { readEnvFile } from "../src/utils/envWriter";
import { getAssignedModels } from "../src/utils/modelRegistryStore";
import { presetToProviderConfig } from "../src/utils/llm/orchestrator";
import { resolveMagnitudeLlmConfig } from "../src/utils/magnitudeLlm";
import {
  buildBrowserAgentConfig,
  ensureBrowserAgent,
  runBrowserAgentExclusive,
  stopBrowserAgent,
} from "../src/services/browser-agent.service";
import {
  snapshotPage,
  runDomAction,
  type DomElement,
} from "../src/services/dom-browser.service";

/** A page with every control shape the DOM path has to handle. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>DOM check</title></head>
<body>
  <h1>Sign in</h1>
  <form onsubmit="event.preventDefault(); document.getElementById('out').textContent =
      'submitted:' + document.getElementById('user').value + ':' + document.getElementById('pw').value;">
    <label for="user">Username</label>
    <input id="user" name="user" type="text" placeholder="your username" />
    <label for="pw">Password</label>
    <input id="pw" name="pw" type="password" />
    <label for="role">Role</label>
    <select id="role" name="role">
      <option value="viewer">Viewer</option>
      <option value="admin">Administrator</option>
    </select>
    <input id="tos" type="checkbox" /> <label for="tos">Accept terms</label>
    <button type="submit">Sign in</button>
  </form>
  <a href="#help">Need help?</a>
  <div id="out" role="status" aria-live="polite"></div>
</body></html>`;

/**
 * A page for the settle / verify checks.
 *
 * "Load results" paints its result a moment after the click — the shape every
 * framework produces, and the reason a click must not be read as a no-op just
 * because the DOM has not caught up yet. "Do nothing" is the opposite case: a
 * click that really has no effect, which must be reported rather than counted as
 * a success. The two fields cover a value the page refuses and one it keeps.
 *
 * The delay is deliberately inside the settle window rather than beyond it: a
 * DOM update driven by a request is covered by the network-idle wait, and one
 * driven by a bare timer longer than the quiet window is not something any
 * settle heuristic can see. Both limits are stated in dom-browser.service.ts.
 */
const SETTLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Settle check</title></head>
<body>
  <button id="load" onclick="setTimeout(function () {
      document.getElementById('results').textContent = '3 results';
    }, 250)">Load results</button>
  <button id="inert">Do nothing</button>
  <input id="picky" aria-label="Picky field"
         oninput="if (this.value === 'rejected') this.value = '';" />
  <input id="keep" aria-label="Keeps its value" />
  <div id="results" role="status" aria-live="polite"></div>
</body></html>`;

function findByName(elements: DomElement[], name: string): DomElement {
  const el = elements.find(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (!el) {
    throw new Error(
      `no element named "${name}" in snapshot:\n` +
        elements.map((e) => `  [${e.id}] ${e.role} "${e.name}"`).join("\n"),
    );
  }
  return el;
}

async function main() {
  loadConfig();
  const env = readEnvFile();

  if (env.MAGNITUDE_ENABLED !== "true") {
    throw new Error("Magnitude is not enabled in backend/.env (MAGNITUDE_ENABLED)");
  }

  const model = getAssignedModels().browser;
  if (!model) throw new Error("No Browser Agent model assigned");
  if (!model.verifiedAt) throw new Error("Browser Agent model is not verified");

  const providerConfig = await presetToProviderConfig(model);
  if (!providerConfig.apiKey) {
    throw new Error("Browser Agent model has no API key");
  }

  // The model only has to configure Magnitude's client; the DOM path never asks
  // it anything, so a text-only model is enough. This is the point of the check.
  const llm = await resolveMagnitudeLlmConfig(
    providerConfig,
    model.reasoningMode,
  );

  const { fingerprint, agentConfig, launch } = buildBrowserAgentConfig({
    llm,
    headless: true,
    proxyUrl: "",
    display: env.MAGNITUDE_DISPLAY || ":99",
    screen: process.env.BROWSER_AGENT_SCREEN || "1280x800x24",
  });

  // Only meaningful for a local launch (BROWSER_AGENT_REMOTE=false): the
  // browser that runs on the attack box is launched there, by path, from the
  // attack box's own image.
  const executable = process.env.BROWSER_CHECK_EXECUTABLE;
  if (executable) {
    agentConfig.browser.launchOptions.executablePath = executable;
  }

  console.log(`\n=== DOM browser path check (model: ${model.label} / ${model.model}) ===`);
  console.log("no screenshots, no vision model, DOM locators only\n");

  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  await runBrowserAgentExclusive(async () => {
    const agent = await ensureBrowserAgent(fingerprint, agentConfig, launch);
    const page = agent.page;

    // Serve the fixture from the page itself: a data: URL keeps this offline.
    await page.goto("data:text/html," + encodeURIComponent(PAGE), {
      waitUntil: "domcontentloaded",
    });

    // 1. Snapshot indexes the controls by role and accessible name.
    const snap = await snapshotPage(page, 2000);
    console.log("element table:");
    console.log(
      snap.table
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
    console.log("");

    check("snapshot finds the form controls", snap.elements.length >= 5,
      `${snap.elements.length} elements`);

    const user = findByName(snap.elements, "Username");
    const pw = findByName(snap.elements, "Password");
    const role = findByName(snap.elements, "Role");
    const tos = findByName(snap.elements, "Accept terms");
    const submit = findByName(snap.elements, "Sign in");

    check("label-linked name resolves", user.name === "Username", `got "${user.name}"`);
    check("placeholder is used when no label exists", !!pw.name, `got "${pw.name}"`);
    check("a <select> is reported as selectable", role.ops.includes("select"),
      role.ops.join("/"));
    check("a checkbox offers check", tos.ops.includes("check"), tos.ops.join("/"));

    // A checkbox that also advertised `fill` sent the model into an action the
    // element refuses, and a listed <label> gave it a second id for a field it
    // already had — both cost a turn each time they happen.
    check("a checkbox does not offer fill", !tos.ops.includes("fill"), tos.ops.join("/"));
    check(
      "a label is not listed beside its own control",
      !snap.elements.some((e) => e.tag === "label"),
      snap.elements.filter((e) => e.tag === "label").map((e) => e.name).join(", "),
    );

    // 2. fill types into a field by id.
    await runDomAction(page, { action: "fill", element_id: user.id, value: "admin" }, snap.elements);
    check("fill by element id", (await page.inputValue("#user")) === "admin");

    // 3. A password value is never echoed into the transcript.
    await runDomAction(page, { action: "fill", element_id: pw.id, value: "s3cr3t" }, snap.elements);
    const pwSnap = await snapshotPage(page, 500);
    const pwEl = pwSnap.elements.find((e) => e.role === "textbox" && e.value.includes("•"));
    check("password value is masked in the snapshot", !!pwEl,
      pwEl ? `value = "${pwEl.value}"` : "no masked value found");

    // 4. select chooses an option by its label.
    await runDomAction(page, { action: "select", element_id: role.id, value: "Administrator" }, snap.elements);
    check("select by option label", (await page.inputValue("#role")) === "admin");

    // 5. check toggles a checkbox.
    await runDomAction(page, { action: "check", element_id: tos.id }, snap.elements);
    check("check toggles the checkbox", await page.isChecked("#tos"));

    // 6. click submits; the page's own handler proves the values arrived.
    await runDomAction(page, { action: "click", element_id: submit.id }, snap.elements);
    const out = await page.textContent("#out");
    check("click submits the filled form", out === "submitted:admin:s3cr3t", `got "${out}"`);

    // 7. A locator works without a snapshot id at all.
    await runDomAction(
      page,
      { action: "fill", locator: { label: "Username" }, value: "second" },
      [],
    );
    check("locator by label (no snapshot id)", (await page.inputValue("#user")) === "second");

    // 8. A stale id is refused with an actionable message rather than a hang.
    let staleMessage = "";
    try {
      await runDomAction(page, { action: "click", element_id: 999 }, snap.elements);
    } catch (err: any) {
      staleMessage = String(err?.message ?? err);
    }
    check("an unknown element id fails fast and says why",
      /No element \[999\]/.test(staleMessage), staleMessage.slice(0, 80));

    // 9. extract_text returns page text, not markup.
    const text = await runDomAction(page, { action: "extract_text", max_chars: 500 }, []);
    check("extract_text returns visible text",
      text.includes("Sign in") && !text.includes("<form"), `${text.length} chars`);

    // 10. Settling and post-action verification.
    //
    // These are the checks for the two things that used to be missing. A click
    // returns before the page has reacted, so the read that followed described
    // the state the action was meant to replace; and the result line claimed
    // success for an action that may have done nothing at all.
    await page.goto("data:text/html," + encodeURIComponent(SETTLE_PAGE), {
      waitUntil: "domcontentloaded",
    });
    const settleSnap = await snapshotPage(page, 2000);

    // (a) The DOM changes only after a delay, the way a real request would.
    //     Without a settle wait this reads as "nothing happened".
    const slow = findByName(settleSnap.elements, "Load results");
    const slowLine = await runDomAction(
      page,
      { action: "click", element_id: slow.id },
      settleSnap.elements,
    );
    check(
      "a click whose result arrives late is not reported as a no-op",
      !/did not change/.test(slowLine),
      slowLine,
    );
    // Read once and assert on that one value. Reading twice made this pass even
    // with the settle wait removed, because the second read happened after the
    // page had caught up — a check that measures its own delay, not the code's.
    const resultsNow = (await page.textContent("#results")) ?? "";
    check(
      "the delayed result is already on the page when the action returns",
      resultsNow.includes("3 results"),
      resultsNow || "(empty)",
    );

    // (b) A click that genuinely does nothing must say so, rather than reporting
    //     a success the model would then build on.
    const inert = findByName(settleSnap.elements, "Do nothing");
    const inertLine = await runDomAction(
      page,
      { action: "click", element_id: inert.id },
      settleSnap.elements,
    );
    check(
      "a click that changes nothing says so",
      /did not change/.test(inertLine),
      inertLine,
    );

    // (c) A value the page refuses is reported, not silently accepted.
    const picky = findByName(settleSnap.elements, "Picky field");
    const pickyLine = await runDomAction(
      page,
      { action: "fill", element_id: picky.id, value: "rejected" },
      settleSnap.elements,
    );
    check(
      "a field that does not keep the value is reported",
      /did not keep the value/.test(pickyLine),
      pickyLine,
    );

    // (d) A value the page keeps is reported as a plain success.
    const keep = findByName(settleSnap.elements, "Keeps its value");
    const keepLine = await runDomAction(
      page,
      { action: "fill", element_id: keep.id, value: "kept" },
      settleSnap.elements,
    );
    check(
      "a field that keeps the value reports no problem",
      !/did not keep/.test(keepLine),
      keepLine,
    );
  });

  await stopBrowserAgent();
  console.log("\nshared agent stopped.");

  const ok = failures.length === 0;
  console.log(`\nverdict: ${ok ? "PASS" : "FAIL"} (${failures.length} failed)`);
  if (!ok) console.log("failed checks: " + failures.join(", "));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("DOM browser check failed:", err);
  process.exit(1);
});
