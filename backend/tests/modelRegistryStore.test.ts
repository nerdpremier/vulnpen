import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the data dir at a scratch directory before importing the store so the
// module resolves the registry path there (see resolveDataDir → DATA_DIR).
let dataDir: string;
before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-registry-"));
  process.env.DATA_DIR = dataDir;
});
after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function loadStore() {
  return import("../src/utils/modelRegistryStore");
}

const preset = {
  label: "Orchestrator",
  provider: "anthropic",
  model: "claude-opus-4-8",
};

test("writeModelRegistry writes the registry file in place", async () => {
  const store = await loadStore();
  const registry = store.writeModelRegistry([preset], {}, false);

  const registryPath = store.getModelRegistryPath();
  assert.equal(registryPath, path.join(dataDir, "model-registry.json"));
  assert.equal(fs.existsSync(registryPath), true);

  const onDisk = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  assert.equal(onDisk.models[0].model, "claude-opus-4-8");
  assert.equal(onDisk.assignments.orchestratorModelId, registry.models[0].id);
});

test("writeModelRegistry leaves no .tmp sibling (no rename-over-mount)", async () => {
  const store = await loadStore();
  store.writeModelRegistry([preset], {}, false);

  const leftovers = fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("overwriting an existing registry updates content without a rename", async () => {
  const store = await loadStore();
  store.writeModelRegistry([preset], {}, false);
  store.writeModelRegistry(
    [{ ...preset, label: "Updated", model: "claude-sonnet-5" }],
    {},
    false,
  );

  const onDisk = JSON.parse(
    fs.readFileSync(store.getModelRegistryPath(), "utf-8"),
  );
  assert.equal(onDisk.models[0].model, "claude-sonnet-5");
  assert.equal(fs.readdirSync(dataDir).some((f) => f.endsWith(".tmp")), false);
});

test("readModelRegistry round-trips the written registry", async () => {
  const store = await loadStore();
  store.writeModelRegistry([preset], {}, false);

  const loaded = store.readModelRegistry();
  assert.equal(loaded.models.length, 1);
  assert.equal(loaded.models[0].model, "claude-opus-4-8");
});

test("keyless subscription presets and max reasoning survive normalization", async () => {
  const store = await loadStore();
  const registry = store.writeModelRegistry(
    [
      {
        id: "codex-local",
        label: "Codex local",
        provider: "codex-subscription",
        model: "gpt-5.6",
        reasoningMode: "max",
      },
      {
        id: "claude-local",
        label: "Claude local",
        provider: "claude-subscription",
        model: "claude-opus-5-latest",
        reasoningMode: "high",
      },
    ],
    { orchestratorModelId: "codex-local" },
    false,
  );
  assert.equal(registry.models[0]?.model, "gpt-5.6-sol");
  assert.equal(registry.models[0]?.apiKey, undefined);
  assert.equal(registry.models[0]?.reasoningMode, "max");
  assert.equal(registry.models[1]?.model, "claude-opus-5");
});

test("verification timestamps survive registry normalization", async () => {
  const store = await loadStore();
  const verifiedAt = "2026-08-14T12:00:00.000Z";
  const registry = store.writeModelRegistry(
    [{ ...preset, id: "verified-model", verifiedAt }],
    { orchestratorModelId: "verified-model" },
    false,
  );
  assert.equal(registry.models[0]?.verifiedAt, verifiedAt);
  assert.equal(store.readModelRegistry().models[0]?.verifiedAt, verifiedAt);
});

// ─── Loopback base URLs in Docker ────────────────────────────────────────
// Inside a container `localhost` is the container, not the host the model
// server runs on. The address is rewritten instead of rejected.

const localPreset = {
  id: "local",
  label: "Local",
  provider: "openai-compatible",
  model: "m",
  baseURL: "http://localhost:11434/v1",
};

function withDocker<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.VULNPEN_DOCKER;
  if (value === undefined) delete process.env.VULNPEN_DOCKER;
  else process.env.VULNPEN_DOCKER = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.VULNPEN_DOCKER;
    else process.env.VULNPEN_DOCKER = previous;
  }
}

test("a loopback base URL is rewritten to the Docker host alias", async () => {
  const store = await loadStore();

  withDocker("1", () => {
    const registry = store.writeModelRegistry([localPreset], {}, false);
    // Port and path survive; only the host moves.
    assert.equal(registry.models[0]?.baseURL, "http://host.docker.internal:11434/v1");
    // And the rewrite reaches the file, so a later load agrees.
    assert.equal(
      JSON.parse(fs.readFileSync(store.getModelRegistryPath(), "utf-8")).models[0].baseURL,
      "http://host.docker.internal:11434/v1",
    );
  });
});

test("every loopback spelling is rewritten, and nothing else is touched", async () => {
  const store = await loadStore();

  withDocker("1", () => {
    for (const [input, expected] of [
      ["http://127.0.0.1:8080/v1", "http://host.docker.internal:8080/v1"],
      ["http://[::1]:8080/v1", "http://host.docker.internal:8080/v1"],
      ["https://localhost/v1?a=1", "https://host.docker.internal/v1?a=1"],
      // No path: no trailing slash is invented.
      ["http://localhost:11434", "http://host.docker.internal:11434"],
      // Already correct, a real remote host, and a service on the compose
      // network all stay exactly as typed.
      ["http://host.docker.internal:20128/v1", "http://host.docker.internal:20128/v1"],
      ["https://api.example.com/v1", "https://api.example.com/v1"],
      ["http://ollama:11434/v1", "http://ollama:11434/v1"],
    ] as const) {
      const registry = store.writeModelRegistry(
        [{ ...localPreset, baseURL: input }],
        {},
        false,
      );
      assert.equal(registry.models[0]?.baseURL, expected, `rewrite of ${input}`);
    }
  });
});

test("outside Docker a loopback base URL is left alone", async () => {
  const store = await loadStore();

  // A host-run backend dials the model server over the real loopback.
  withDocker(undefined, () => {
    const registry = store.writeModelRegistry([localPreset], {}, false);
    assert.equal(registry.models[0]?.baseURL, "http://localhost:11434/v1");
  });
});

test("an unparseable base URL is stored as typed for the provider to report", async () => {
  const store = await loadStore();

  withDocker("1", () => {
    const registry = store.writeModelRegistry(
      [{ ...localPreset, baseURL: "localhost:11434" }],
      {},
      false,
    );
    assert.equal(registry.models[0]?.baseURL, "localhost:11434");
  });
});

// ─── What the operator declares about an endpoint ───────────────────────
// These two numbers decide where the agent summarizes and how much room it
// leaves for the next turn, so they have to survive a save/load round-trip and
// a nonsense value must never become a plan.

test("a declared window and output ceiling survive the round-trip", async () => {
  const store = await loadStore();
  const registry = store.writeModelRegistry(
    [{ ...preset, contextWindow: 200_000, maxOutputTokens: 32_000 }],
    {},
    false,
  );

  const onDisk = JSON.parse(fs.readFileSync(store.getModelRegistryPath(), "utf-8"));
  assert.equal(onDisk.models[0].contextWindow, 200_000);
  assert.equal(onDisk.models[0].maxOutputTokens, 32_000);
  assert.equal(registry.models[0]?.contextWindow, 200_000);
});

test("a declared count that cannot be a window is treated as not declared", async () => {
  const store = await loadStore();
  const registry = store.writeModelRegistry(
    [
      { ...preset, id: "zero", contextWindow: 0, maxOutputTokens: -5 },
      { ...preset, id: "nan", contextWindow: Number.NaN, maxOutputTokens: "32000" },
      { ...preset, id: "huge", contextWindow: 1_000, maxOutputTokens: 9_000_000 },
    ],
    {},
    false,
  );

  const [zero, nan, huge] = registry.models;
  assert.equal(zero?.contextWindow, undefined, "0 is not a window");
  assert.equal(zero?.maxOutputTokens, undefined, "-5 is not a ceiling");
  assert.equal(nan?.contextWindow, undefined, "NaN is not a window");
  // The form hands back what was typed, so a numeric string is still a number.
  assert.equal(nan?.maxOutputTokens, 32_000);
  assert.equal(
    huge?.maxOutputTokens,
    1_000,
    "a ceiling cannot exceed the window it has to fit inside",
  );
});
