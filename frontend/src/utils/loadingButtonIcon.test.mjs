import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A loading button must pass its icon through the `icon` prop.
 *
 * antd swaps that prop for the spinner while loading (`button.js`: `if (icon
 * && !innerLoading)`), but an icon written into the children is just another
 * child — so it stays on screen next to the spinner. That is not a style
 * choice anyone made; it is what `<Button loading={saving}><CheckOutlined />
 * Test & Save</Button>` does, and it is the natural way to write it, which is
 * why this is checked rather than remembered. It shipped once: the "Test &
 * Save" button showed a checkmark and a spinner at the same time.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Bounded on purpose: the window is wide enough for the real elements (the
 * longest opening tag in this codebase is ~250 characters) and narrow enough
 * that it cannot reach from one button to the next. A JSX parser would be more
 * precise, but the shape being caught is a single element's opening tag
 * followed by its first child.
 */
const ICON_IN_THE_LABEL_OF_A_LOADING_BUTTON =
  /<(?:Button|PrimaryButton)[^>]{0,300}?loading=\{[^}]{0,60}\}[^>]{0,300}?>\s*\n\s*<[A-Z]\w*(?:Outlined|Filled|TwoTone)/;

function jsxFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsxFiles(full));
    else if (entry.name.endsWith(".jsx")) found.push(full);
  }
  return found;
}

test("the detector fires on the shape it is meant to catch", () => {
  // Without this the guard below would keep passing if the pattern ever
  // stopped matching anything at all.
  assert.ok(
    ICON_IN_THE_LABEL_OF_A_LOADING_BUTTON.test(`
              <PrimaryButton
                loading={saving}
              >
                <CheckOutlined /> Test &amp; Save
              </PrimaryButton>`),
    "a checkmark in the label of a loading button must be reported",
  );

  // And it must not fire on the corrected form, or on a button that has an
  // icon but no loading state.
  assert.ok(
    !ICON_IN_THE_LABEL_OF_A_LOADING_BUTTON.test(`
              <PrimaryButton
                loading={saving}
                icon={<CheckOutlined />}
              >
                Test &amp; Save
              </PrimaryButton>`),
    "an icon in the prop is the fix, not a second offence",
  );
  assert.ok(
    !ICON_IN_THE_LABEL_OF_A_LOADING_BUTTON.test(`
              <PrimaryButton>
                <CheckOutlined /> Test &amp; Save
              </PrimaryButton>`),
    "a button with no spinner keeps whatever icon it likes",
  );
});

test("no loading button carries its icon in the label", () => {
  const offenders = jsxFiles(SRC)
    .filter((file) =>
      ICON_IN_THE_LABEL_OF_A_LOADING_BUTTON.test(fs.readFileSync(file, "utf8")),
    )
    .map((file) => path.relative(SRC, file));

  assert.deepEqual(
    offenders,
    [],
    `move the icon into the icon prop so antd can replace it with the spinner:\n${offenders.join("\n")}`,
  );
});
