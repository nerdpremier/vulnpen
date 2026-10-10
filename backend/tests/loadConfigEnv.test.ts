import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, reloadEnv } from "../src/utils/loadConfig";

/**
 * loadConfig/reloadEnv hold module-level state (a one-shot loaded flag and the
 * set of keys adopted from .env), so both halves of the contract live in one
 * test: the container's environment is authoritative, and a Settings write to
 * .env may only refresh the keys .env itself supplied.
 *
 * This is the regression behind a Docker deploy that could not reach its own
 * work host: compose exports SSH_HOST=kali / SSH_PORT=22 (the in-network
 * address), while the mounted .env still carries the host-facing
 * localhost:4242. reloadEnv used to hand .env the win and the backend then
 * dialled 127.0.0.1:4242 from inside its own container.
 */
test("a mounted .env never overrides the container's environment, at boot or on reload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-env-"));
  const envPath = path.join(root, ".env");
  const saved = { ...process.env };
  try {
    fs.writeFileSync(
      envPath,
      'SSH_HOST="localhost"\nSSH_PORT="4242"\nLANGFUSE_ENABLED="true"\n',
    );

    process.env.DATA_DIR = root;
    process.env.SSH_HOST = "kali";
    process.env.SSH_PORT = "22";
    delete process.env.LANGFUSE_ENABLED;

    loadConfig();
    assert.equal(process.env.SSH_HOST, "kali");
    assert.equal(process.env.SSH_PORT, "22");
    assert.equal(process.env.LANGFUSE_ENABLED, "true");

    // Every Settings/magnitude/Burp write lands here, with .env rewritten.
    fs.writeFileSync(
      envPath,
      'SSH_HOST="localhost"\nSSH_PORT="4242"\nLANGFUSE_ENABLED="false"\n',
    );
    reloadEnv();
    assert.equal(process.env.SSH_HOST, "kali");
    assert.equal(process.env.SSH_PORT, "22");
    assert.equal(process.env.LANGFUSE_ENABLED, "false");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
