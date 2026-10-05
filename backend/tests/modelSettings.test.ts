import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the data dir at a scratch directory before importing the modules so
// the registry resolves there (see resolveDataDir → DATA_DIR).
let dataDir: string;
before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-settings-"));
  process.env.DATA_DIR = dataDir;
});
after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function loadModules() {
  const store = await import("../src/utils/modelRegistryStore");
  const settings = await import("../src/services/model-settings.service");
  const orchestrator = await import("../src/utils/llm/orchestrator");
  return { store, settings, orchestrator };
}

const anthropicPreset = {
  id: "main",
  label: "Main",
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKey: "sk-real-secret",
  verifiedAt: "2026-01-01T00:00:00.000Z",
};

test("saveModels restores masked api keys from the saved preset", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([anthropicPreset], { orchestratorModelId: "main" }, false);

  const verified: string[] = [];
  const registry = await settings.saveModels(
    [{ ...anthropicPreset, apiKey: "sk-r••••••••cret" }],
    { orchestratorModelId: "main" },
    { verify: async (model) => { verified.push(model.id); return "now"; } },
  );

  assert.equal(registry.models[0]?.apiKey, "sk-real-secret");
  // Unchanged preset: the saved verification stands, no probe fired.
  assert.deepEqual(verified, []);
  assert.equal(registry.models[0]?.verifiedAt, "2026-01-01T00:00:00.000Z");
});

test("saveModels re-verifies a preset whose credentials changed", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([anthropicPreset], { orchestratorModelId: "main" }, false);

  const verified: string[] = [];
  const registry = await settings.saveModels(
    [{ ...anthropicPreset, apiKey: "sk-brand-new" }],
    { orchestratorModelId: "main" },
    { verify: async (model) => { verified.push(model.id); return "fresh-stamp"; } },
  );

  assert.deepEqual(verified, ["main"]);
  assert.equal(registry.models[0]?.verifiedAt, "fresh-stamp");
});

test("saveModels re-verifies an assigned preset that was never verified", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry(
    [{ ...anthropicPreset, verifiedAt: undefined }],
    { orchestratorModelId: "main" },
    false,
  );

  const verified: string[] = [];
  const registry = await settings.saveModels(
    [{ ...anthropicPreset, verifiedAt: undefined }],
    { orchestratorModelId: "main" },
    { verify: async (model) => { verified.push(model.id); return "first-stamp"; } },
  );

  assert.deepEqual(verified, ["main"]);
  assert.equal(registry.models[0]?.verifiedAt, "first-stamp");
});

test("saveModels rejects duplicate ids and invalid presets", async () => {
  const { settings } = await loadModules();

  await assert.rejects(
    () => settings.saveModels(
      [anthropicPreset, { ...anthropicPreset, label: "Twin" }],
      {},
      { verify: async () => "t" },
    ),
    /Duplicate model id "main"/,
  );

  await assert.rejects(
    () => settings.saveModels([{ id: "broken", label: "No provider" }], {}),
    /Each model must have id, label, valid provider, and model fields/,
  );

  await assert.rejects(
    () => settings.saveModels([{ label: "No id" }], {}),
    /Each model must have an id/,
  );
});

test("every mutation clears the orchestrator provider cache", async () => {
  const { settings, orchestrator } = await loadModules();
  orchestrator.clearProviderCache();

  const verify = async () => "stamp";
  await settings.saveModels(
    [{
      id: "a", label: "A", provider: "anthropic",
      model: "claude-opus-4-8", apiKey: "sk-aaa",
    }],
    { orchestratorModelId: "a" },
    { verify },
  );
  let config = await orchestrator.getProvider();
  assert.equal(config.apiKey, "sk-aaa");

  // Swap the orchestrator through the settings seam. Without the cache
  // clear, getProvider would serve sk-aaa for up to 30 more seconds.
  await settings.saveModels(
    [{
      id: "b", label: "B", provider: "anthropic",
      model: "claude-sonnet-5", apiKey: "sk-bbb",
    }],
    { orchestratorModelId: "b" },
    { verify },
  );
  config = await orchestrator.getProvider();
  assert.equal(config.apiKey, "sk-bbb");
});

test("assignOrchestratorPreset keeps verifiedAt only while the preset is unchanged", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([anthropicPreset], { orchestratorModelId: "main" }, false);

  // Same credentials, masked key: restored, unchanged, stamp survives.
  const unchanged = await settings.assignOrchestratorPreset({
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "sk-r••••••••cret",
  });
  assert.equal(
    unchanged.models.find((m) => m.id === "main")?.verifiedAt,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(
    unchanged.models.find((m) => m.id === "main")?.apiKey,
    "sk-real-secret",
  );

  // Model moved: the old stamp must not vouch for the new model.
  const changed = await settings.assignOrchestratorPreset({
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "sk-real-secret",
  });
  assert.equal(
    changed.models.find((m) => m.id === "main")?.verifiedAt,
    undefined,
  );
  assert.equal(changed.assignments.orchestratorModelId, "main");
});

test("assignOrchestratorPreset validates provider and reasoning mode", async () => {
  const { settings } = await loadModules();

  await assert.rejects(
    () => settings.assignOrchestratorPreset({ provider: "not-a-provider", model: "m" }),
    /Invalid provider/,
  );
  await assert.rejects(
    () => settings.assignOrchestratorPreset({
      provider: "anthropic", model: "claude-opus-4-8",
      apiKey: "sk-x", reasoningMode: "sideways",
    }),
    /Invalid reasoning mode/,
  );
  await assert.rejects(
    () => settings.assignOrchestratorPreset({ provider: "anthropic" }),
    /Provider and model are required/,
  );
});

test("connectSubscriptionPreset slugifies the id so the assignment survives strict validation", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([], {}, false);

  const { registry, presetId } = settings.connectSubscriptionPreset({
    provider: "codex-subscription",
    model: "gpt-5.6",
  });

  assert.equal(presetId, "codex-subscription-gpt-5-6");
  assert.equal(registry.assignments.orchestratorModelId, presetId);
  const preset = registry.models.find((m) => m.id === presetId);
  assert.ok(preset);
  assert.equal(preset.label, "Codex · gpt-5.6");
});

test("connectSubscriptionPreset respects an existing orchestrator assignment", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([anthropicPreset], { orchestratorModelId: "main" }, false);

  const { registry } = settings.connectSubscriptionPreset({
    provider: "claude-subscription",
    model: "claude-opus-5-latest",
    assignOrchestrator: false,
  });

  assert.equal(registry.assignments.orchestratorModelId, "main");
  assert.equal(registry.models.length, 2);
});

test("markPresetVerified stamps every matching preset", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([anthropicPreset], { orchestratorModelId: "main" }, false);

  const registry = settings.markPresetVerified("anthropic", "claude-opus-4-8");
  const verifiedAt = registry.models[0]?.verifiedAt;
  assert.ok(verifiedAt);
  assert.notEqual(verifiedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(
    store.readModelRegistry().models[0]?.verifiedAt,
    verifiedAt,
  );
});

test("clearOrchestratorAssignment falls back to the first model", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry(
    [anthropicPreset, { ...anthropicPreset, id: "second", label: "Second" }],
    { orchestratorModelId: "second" },
    false,
  );

  const registry = settings.clearOrchestratorAssignment();
  assert.equal(registry.assignments.orchestratorModelId, "main");
});

test("setBrowserModel assigns and clears the Browser Agent model", async () => {
  const { store, settings } = await loadModules();
  store.writeModelRegistry([anthropicPreset], {}, false);

  const assigned = settings.setBrowserModel("main");
  assert.equal(assigned.assignments.browserModelId, "main");

  const cleared = settings.setBrowserModel("");
  assert.equal(cleared.assignments.browserModelId, undefined);
});
