import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_OPTIONS,
  createModelId,
  needsBaseURL,
  baseURLPlaceholder,
  providerLabel,
  assignedIds,
} from "./modelConfig.mjs";

test("createModelId slugifies the label and appends a unique suffix", () => {
  const id = createModelId("My Cool Model!");

  assert.match(id, /^my-cool-model-.+$/);
  // the suffix makes two calls distinct
  assert.notEqual(createModelId("Same Label"), createModelId("Same Label"));
  // a label with no usable characters falls back to "model"
  assert.match(createModelId("!!!"), /^model-.+$/);
  // an empty label falls back too
  assert.match(createModelId(""), /^model-.+$/);
});

test("needsBaseURL only for self-hosted providers", () => {
  assert.equal(needsBaseURL("ollama"), true);
  assert.equal(needsBaseURL("openai-compatible"), true);
  assert.equal(needsBaseURL("openrouter"), false);
});

test("baseURLPlaceholder points at the local default for ollama", () => {
  assert.match(baseURLPlaceholder("ollama"), /host\.docker\.internal/);
  assert.match(baseURLPlaceholder("openai-compatible"), /^https:\/\//);
});

test("providerLabel falls back to the raw value for unknown providers", () => {
  assert.equal(providerLabel("ollama"), "Ollama (Local)");
  assert.equal(providerLabel("custom-provider"), "custom-provider");
  assert.ok(PROVIDER_OPTIONS.length >= 3);
});

test("assignedIds collects the distinct assignment ids", () => {
  assert.deepEqual(
    [...assignedIds({ orchestratorModelId: "a", browserModelId: "b" })].sort(),
    ["a", "b"],
  );
  assert.deepEqual(
    [...assignedIds({ orchestratorModelId: "a", browserModelId: "a" })],
    ["a"],
  );
  assert.equal(assignedIds({}).size, 0);
  assert.equal(assignedIds(undefined).size, 0);
});

