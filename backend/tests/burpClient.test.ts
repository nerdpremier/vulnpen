import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBurpRpcConfig, openBurpClient } from "../src/services/burp-client.service";

// getBurpRpcConfig reads the .env file under DATA_DIR at call time (never at
// import time), so each test points DATA_DIR at a fresh temp directory and
// writes the .env it needs.
const originalDataDir = process.env.DATA_DIR;

function withDataDir(envVars: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burp-client-test-"));
  const lines = Object.entries(envVars).map(([k, v]) => `${k}="${v}"`);
  fs.writeFileSync(path.join(dir, ".env"), lines.join("\n") + "\n", "utf-8");
  process.env.DATA_DIR = dir;
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.DATA_DIR = originalDataDir;
}

test("returns null when Burp RPC host is not configured", () => {
  const dir = withDataDir({});
  try {
    assert.equal(getBurpRpcConfig(), null);
  } finally {
    cleanup(dir);
  }
});

test("returns null when the host is only whitespace", () => {
  const dir = withDataDir({ BURP_RPC_HOST: "   " });
  try {
    assert.equal(getBurpRpcConfig(), null);
  } finally {
    cleanup(dir);
  }
});

test("applies the default port when only a host is set", () => {
  const dir = withDataDir({ BURP_RPC_HOST: "127.0.0.1" });
  try {
    assert.deepEqual(getBurpRpcConfig(), { host: "127.0.0.1", port: 50051 });
  } finally {
    cleanup(dir);
  }
});

test("parses a configured host and port", () => {
  const dir = withDataDir({ BURP_RPC_HOST: "kali-box", BURP_RPC_PORT: "50052" });
  try {
    assert.deepEqual(getBurpRpcConfig(), { host: "kali-box", port: 50052 });
  } finally {
    cleanup(dir);
  }
});

test("openBurpClient reports not-configured instead of throwing", async () => {
  const dir = withDataDir({});
  try {
    const opened = await openBurpClient();
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, "not-configured");
  } finally {
    cleanup(dir);
  }
});

test("openBurpClient opens a client bound to the configured host and port", async () => {
  const dir = withDataDir({ BURP_RPC_HOST: "127.0.0.1", BURP_RPC_PORT: "50053" });
  try {
    const opened = await openBurpClient();
    assert.equal(opened.ok, true);
    if (opened.ok) {
      assert.deepEqual(opened.config, { host: "127.0.0.1", port: 50053 });
      opened.client.close();
    }
  } finally {
    cleanup(dir);
  }
});
