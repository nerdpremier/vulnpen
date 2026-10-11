import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBrowserAgentActive,
  isBrowserUsedInRun,
  agentOwnsBrowserPanel,
} from "./browserAgentActivity.mjs";

const streamingTool = (overrides = {}) => ({
  id: "tool_abc",
  role: "tool",
  toolCallId: "abc",
  toolName: "browser_action",
  args: { action: "snapshot" },
  content: "",
  streaming: true,
  ...overrides,
});

test("a streaming browser_action counts as the agent driving the browser", () => {
  assert.equal(isBrowserAgentActive([streamingTool()]), true);
});

test("a finished browser_action does not", () => {
  assert.equal(
    isBrowserAgentActive([streamingTool({ streaming: false })]),
    false,
  );
});

test("another tool streaming is not browser activity", () => {
  assert.equal(
    isBrowserAgentActive([streamingTool({ toolName: "run_bash" })]),
    false,
  );
});

test("an absent or malformed message list is not activity", () => {
  assert.equal(isBrowserAgentActive(undefined), false);
  assert.equal(isBrowserAgentActive(null), false);
  assert.equal(isBrowserAgentActive([]), false);
});

test("the panel is owned while a browser call is in flight", () => {
  assert.equal(
    agentOwnsBrowserPanel({ browserActive: true, runLive: true, browserUsed: true }),
    true,
  );
});

// The regression this exists for: the model thinks for seconds between two
// browser steps, so between calls `browserActive` is false. Folding there is
// what made the panel flap open and shut once per step.
test("a gap between two browser steps of the same run keeps the panel", () => {
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: false,
      runLive: true,
      browserUsed: true,
    }),
    true,
  );
});

test("the panel is released when the run ends", () => {
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: false,
      runLive: false,
      browserUsed: true,
    }),
    false,
  );
});

test("a run that never touched the browser never takes the panel", () => {
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: false,
      runLive: true,
      browserUsed: false,
    }),
    false,
  );
});

test("a browser call still finishing when the run ends keeps the panel", () => {
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: true,
      runLive: false,
      browserUsed: true,
    }),
    true,
  );
});

/* ---- run-scoped "has the browser been used" ---- */

const userMessage = { id: "u1", role: "user", content: "test the login page" };
const assistantMessage = { id: "a1", role: "assistant", content: "on it" };
const finishedBrowserTool = streamingTool({ streaming: false });

test("a finished browser call in this run counts as the browser being used", () => {
  assert.equal(
    isBrowserUsedInRun([userMessage, assistantMessage, finishedBrowserTool]),
    true,
  );
});

test("browser work from an earlier run does not count", () => {
  assert.equal(
    isBrowserUsedInRun([
      userMessage,
      finishedBrowserTool,
      { id: "u2", role: "user", content: "now check the report" },
      assistantMessage,
    ]),
    false,
  );
});

test("a run that only used other tools has not used the browser", () => {
  assert.equal(
    isBrowserUsedInRun([
      userMessage,
      streamingTool({ toolName: "run_bash", streaming: false }),
    ]),
    false,
  );
});

test("an absent message list has no browser use", () => {
  assert.equal(isBrowserUsedInRun(undefined), false);
  assert.equal(isBrowserUsedInRun([]), false);
});

// End to end over one run: open on the first step, stay open through the gap
// the model thinks in, and fold only when the run ends.
test("one run opens the panel once and folds it when the run ends", () => {
  const step1 = [userMessage, streamingTool()];
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: isBrowserAgentActive(step1),
      runLive: true,
      browserUsed: isBrowserUsedInRun(step1),
    }),
    true,
  );

  const betweenSteps = [userMessage, finishedBrowserTool];
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: isBrowserAgentActive(betweenSteps),
      runLive: true,
      browserUsed: isBrowserUsedInRun(betweenSteps),
    }),
    true,
  );

  const step2 = [userMessage, finishedBrowserTool, streamingTool({ id: "tool_2" })];
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: isBrowserAgentActive(step2),
      runLive: true,
      browserUsed: isBrowserUsedInRun(step2),
    }),
    true,
  );

  const runOver = [userMessage, finishedBrowserTool];
  assert.equal(
    agentOwnsBrowserPanel({
      browserActive: isBrowserAgentActive(runOver),
      runLive: false,
      browserUsed: isBrowserUsedInRun(runOver),
    }),
    false,
  );
});
