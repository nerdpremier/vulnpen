import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/utils/assistant/prompts";

// The prompt sections advertising Burp and the browser agent key off the same
// readiness seam the schema filter uses (unconfiguredToolNames), not on env
// reads inside the prompt builder — the prompt can never advertise an
// integration the model is not actually offered.

test("the Burp integration section is dropped when a Burp tool is not ready", () => {
  const ready = buildSystemPrompt({ sessionId: "s" } as any);
  assert.match(ready, /<burp_integration>/);

  const unready = buildSystemPrompt({
    sessionId: "s",
    unconfiguredToolNames: ["send_to_burp_repeater"],
  } as any);
  assert.doesNotMatch(unready, /<burp_integration>/);
});

test("browser readiness switches the testing-discipline line", () => {
  const ready = buildSystemPrompt({ sessionId: "s" } as any);
  assert.match(ready, /browser agent and Burp are wired together/);

  const unready = buildSystemPrompt({
    sessionId: "s",
    unconfiguredToolNames: ["browser_action"],
  } as any);
  assert.match(unready, /otherwise curl and the shell/);
  assert.doesNotMatch(unready, /browser agent and Burp are wired together/);
});
