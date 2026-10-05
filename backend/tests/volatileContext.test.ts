import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VOLATILE_SYSTEM_MARKER,
  buildVolatileTail,
  injectVolatileTail,
  splitVolatileTail,
} from "../src/utils/assistant/volatileContext";

test("buildVolatileTail wraps clock, state and web-app parts in the marker", () => {
  const tail = buildVolatileTail({
    timezone: "Asia/Bangkok",
    stateBlock: "\n<engagement_state type=\"pentest\">x</engagement_state>",
    webApp: "<wstg_state>plan</wstg_state>",
  });
  assert.ok(tail.startsWith(VOLATILE_SYSTEM_MARKER));
  assert.ok(tail.endsWith("</volatile_system>"));
  assert.match(tail, /<run_clock>Current time: \d{2}:\d{2} Asia\/Bangkok<\/run_clock>/);
  assert.match(tail, /<engagement_state/);
  assert.match(tail, /<wstg_state>plan<\/wstg_state>/);
});

test("injectVolatileTail replaces an existing tail instead of stacking them", () => {
  const staticPrompt = "<role>static</role>";
  const first = injectVolatileTail(
    staticPrompt,
    buildVolatileTail({ timezone: "UTC", stateBlock: "", webApp: "old" }),
  );
  const second = injectVolatileTail(
    first,
    buildVolatileTail({ timezone: "UTC", stateBlock: "", webApp: "new" }),
  );
  assert.match(second, /new/);
  assert.doesNotMatch(second, /old/);
  assert.equal(second.match(new RegExp(VOLATILE_SYSTEM_MARKER, "g"))!.length, 1);
});

test("injectVolatileTail appends the tail when the static prompt has none", () => {
  const out = injectVolatileTail("<role>static</role>", "<volatile_system>tail</volatile_system>");
  assert.ok(out.startsWith("<role>static</role>"));
  assert.ok(out.endsWith("<volatile_system>tail</volatile_system>"));
});

test("splitVolatileTail separates the cacheable prefix from the volatile tail", () => {
  const staticPrompt = "<role>static</role>";
  const tail = buildVolatileTail({ timezone: "UTC", stateBlock: "", webApp: "plan" });
  const { staticPrefix, volatileTail } = splitVolatileTail(injectVolatileTail(staticPrompt, tail));
  assert.equal(staticPrefix.trimEnd(), staticPrompt);
  assert.equal(volatileTail, tail);
});

test("splitVolatileTail passes through content without a marker", () => {
  const { staticPrefix, volatileTail } = splitVolatileTail("plain system prompt");
  assert.equal(staticPrefix, "plain system prompt");
  assert.equal(volatileTail, "");
});
