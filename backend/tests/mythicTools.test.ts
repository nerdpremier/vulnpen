import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, spawnSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

// The Mythic client resolves its config from <DATA_DIR>/.env, so point DATA_DIR at a
// scratch directory before anything imports it. This keeps the tests deterministic
// regardless of whether the developer has a real Mythic server configured.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mythic-tools-test-"));
process.env.DATA_DIR = dataDir;

function writeEnv(vars: Record<string, string>) {
  const body = Object.entries(vars)
    .map(([key, value]) => `${key}="${value}"`)
    .join("\n");
  fs.writeFileSync(path.join(dataDir, ".env"), `${body}\n`, "utf8");
}

writeEnv({});

const mythicCallbacks = require("../src/tools/handlers/mythic-callbacks").default;
const mythicTask = require("../src/tools/handlers/mythic-task").default;
const mythicTaskResults = require("../src/tools/handlers/mythic-task-results").default;
const mythicPivot = require("../src/tools/handlers/mythic-pivot").default;
const mythicPayload = require("../src/tools/handlers/mythic-payload").default;
const mythicListener = require("../src/tools/handlers/mythic-listener").default;
const mythicLoot = require("../src/tools/handlers/mythic-loot").default;
const mythicGraphqlTool = require("../src/tools/handlers/mythic-graphql").default;
const { writeBufferToWorkHost } = require("../src/services/mythic.client");
const { mythicRoutes } = require("../src/routes/mythic.routes");
const { verifySess } = require("../src/middlewares/VerifySession.middleware");
const { getUnconfiguredToolNames, MYTHIC_TOOLS } = require("../src/utils/toolAvailability");

import type { ExecutionContext } from "../src/tools/types";

const ctx = { sessionId: "session-1" } as ExecutionContext;

test("every Mythic tool refuses cleanly when unconfigured", async () => {
  writeEnv({});
  const tools = [
    mythicCallbacks,
    mythicTask,
    mythicTaskResults,
    mythicPivot,
    mythicPayload,
    mythicListener,
    mythicLoot,
    mythicGraphqlTool,
  ];
  for (const tool of tools) {
    const result = await tool.execute(
      { action: "list", query: "{ __typename }", callback_display_id: 1, command: "ls" },
      ctx,
    );
    assert.equal(result.exitCode, 1, `${tool.name} should fail when unconfigured`);
    assert.match(result.output, /not configured/i, `${tool.name} should say it is not configured`);
  }
});

test("Mythic tools are hidden from the LLM until URL and token are both set", () => {
  writeEnv({});
  let unconfigured = getUnconfiguredToolNames();
  for (const name of MYTHIC_TOOLS) {
    assert.ok(unconfigured.includes(name), `${name} should be unconfigured with no env`);
  }

  // URL alone is not enough — a token is required too.
  writeEnv({ MYTHIC_URL: "https://mythic.example:7443" });
  unconfigured = getUnconfiguredToolNames();
  assert.ok(unconfigured.includes("mythic_task"), "URL without a token must still count as unconfigured");

  writeEnv({ MYTHIC_URL: "https://mythic.example:7443", MYTHIC_API_TOKEN: "mtk_test" });
  unconfigured = getUnconfiguredToolNames();
  for (const name of MYTHIC_TOOLS) {
    assert.ok(!unconfigured.includes(name), `${name} should be available once configured`);
  }
});

test("tasking validates its arguments before touching the network", async () => {
  writeEnv({ MYTHIC_URL: "https://127.0.0.1:1", MYTHIC_API_TOKEN: "mtk_test" });

  const missingCallback = await mythicTask.execute({ action: "issue", command: "whoami" }, ctx);
  assert.equal(missingCallback.exitCode, 1);
  assert.match(missingCallback.output, /callback_display_id is required/);

  const missingCommand = await mythicTask.execute({ action: "issue", callback_display_id: 1 }, ctx);
  assert.equal(missingCommand.exitCode, 1);
  assert.match(missingCommand.output, /command is required/);

  const unknownAction = await mythicTask.execute({ action: "nope" }, ctx);
  assert.equal(unknownAction.exitCode, 1);
  assert.match(unknownAction.output, /Unknown action/);

  const missingTaskId = await mythicTaskResults.execute({ action: "output" }, ctx);
  assert.equal(missingTaskId.exitCode, 1);
  assert.match(missingTaskId.output, /task_display_id is required/);
});

test("pivot validates the port before tasking", async () => {
  writeEnv({ MYTHIC_URL: "https://127.0.0.1:1", MYTHIC_API_TOKEN: "mtk_test" });

  const noPort = await mythicPivot.execute({ action: "socks_start", callback_display_id: 1 }, ctx);
  assert.equal(noPort.exitCode, 1);
  assert.match(noPort.output, /valid port is required/);

  const badPort = await mythicPivot.execute(
    { action: "socks_start", callback_display_id: 1, port: 99999 },
    ctx,
  );
  assert.equal(badPort.exitCode, 1);
  assert.match(badPort.output, /valid port is required/);
});

test("an unreachable Mythic server produces a friendly message, not a stack", async () => {
  // Port 1 on loopback refuses immediately, exercising the transport error mapping.
  writeEnv({ MYTHIC_URL: "https://127.0.0.1:1", MYTHIC_API_TOKEN: "mtk_test" });

  const result = await mythicCallbacks.execute({ action: "list" }, ctx);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /unreachable|TLS error/i);
  assert.doesNotMatch(result.output, /at Object\.|node_modules|Error:\s*connect/i);
});

test("main-agent modes review Mythic tasking while routine autonomous commands remain available", () => {
  assert.equal(mythicTask.requiresConsent, true);

  // High-impact target actions cross the main-agent review boundary. Routine
  // commands stay available to subagents, swarms, and MCP callers.
  assert.equal(
    mythicTask.shouldRequireConsent!({ action: "issue", command: "execute_assembly" }, ctx),
    true,
  );
  assert.equal(mythicTask.shouldRequireConsent!({ action: "issue_and_wait", command: "psexec" }, ctx), true);
  assert.equal(mythicTask.shouldRequireConsent!({ action: "issue", command: "ls" }, ctx), false);
});

test("read-only tools never prompt", () => {
  // requiresConsent is tool-level, so reads live in their own tools to keep polling
  // and enumeration free of approval prompts.
  for (const tool of [mythicCallbacks, mythicTaskResults, mythicGraphqlTool]) {
    assert.notEqual(tool.requiresConsent, true, `${tool.name} should not be tool-level consent-gated`);
  }
  assert.equal(mythicTaskResults.shouldRequireConsent, undefined);
  assert.equal(mythicCallbacks.shouldRequireConsent!({ action: "list" }, ctx), false);
  assert.equal(mythicGraphqlTool.shouldRequireConsent!({ query: "{ callback { id } }" }, ctx), false);
});

test("mixed read/write tools gate only their write actions", () => {
  for (const tool of [mythicCallbacks, mythicPivot, mythicPayload, mythicListener, mythicLoot]) {
    assert.notEqual(tool.requiresConsent, true, `${tool.name} must not prompt on its read actions`);
  }

  assert.equal(mythicPivot.shouldRequireConsent!({ action: "socks_start" }, ctx), true);
  assert.equal(mythicPivot.shouldRequireConsent!({ action: "rpfwd_start" }, ctx), true);
  assert.equal(mythicPivot.shouldRequireConsent!({ action: "list" }, ctx), false);

  assert.equal(mythicPayload.shouldRequireConsent!({ action: "create" }, ctx), true);
  assert.equal(mythicPayload.shouldRequireConsent!({ action: "download" }, ctx), true);
  assert.equal(mythicPayload.shouldRequireConsent!({ action: "list" }, ctx), false);

  assert.equal(mythicListener.shouldRequireConsent!({ action: "start" }, ctx), true);
  assert.equal(mythicListener.shouldRequireConsent!({ action: "stop" }, ctx), true);
  assert.equal(mythicListener.shouldRequireConsent!({ action: "list" }, ctx), false);

  assert.equal(mythicLoot.shouldRequireConsent!({ action: "upload_file" }, ctx), true);
  assert.equal(mythicLoot.shouldRequireConsent!({ action: "download_file" }, ctx), false);
  assert.equal(mythicLoot.shouldRequireConsent!({ action: "add_credential" }, ctx), false);
  assert.equal(mythicLoot.shouldRequireConsent!({ action: "list_credentials" }, ctx), false);

  assert.equal(mythicCallbacks.shouldRequireConsent!({ action: "update" }, ctx), true);
  assert.equal(mythicCallbacks.shouldRequireConsent!({ action: "list" }, ctx), false);
});

test("raw GraphQL passthrough hard-gates mutations but not queries", () => {
  assert.equal(mythicGraphqlTool.shouldRequireConsent!({ query: "{ callback { id } }" }, ctx), false);
  assert.equal(
    mythicGraphqlTool.shouldRequireConsent!({ query: "mutation { createTask(command: \"ls\") { id } }" }, ctx),
    true,
  );
  assert.equal(
    mythicGraphqlTool.shouldRequireConsent!({ query: "  mutation Foo($a: Int) { bar }" }, ctx),
    true,
  );
  assert.equal(mythicGraphqlTool.shouldRequireConsent!({ query: ",mutation { bar }" }, ctx), true);
  assert.equal(
    mythicGraphqlTool.shouldRequireConsent!({ query: "# mutation { dangerous }\nquery { callback { id } }" }, ctx),
    false,
  );
  assert.equal(
    mythicGraphqlTool.shouldRequireConsent!({ query: 'query { search(value: "mutation { nope }") }' }, ctx),
    false,
  );
  assert.equal(
    mythicGraphqlTool.shouldRequireConsent!({ query: "fragment mutation on callback { id }\nquery { callback { ...mutation } }" }, ctx),
    false,
  );
});

test("every Mythic REST endpoint requires an authenticated session", () => {
  for (const layer of mythicRoutes.stack) {
    assert.ok(layer.route, "Mythic router should contain only route layers");
    assert.equal(
      layer.route.stack[0].handle,
      verifySess,
      `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path} should require a session`,
    );
  }
});

test("Mythic configuration is readable by users but only writable by the installation owner", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `const { userRoutes } = require("./src/routes/user.routes.ts");
       const { requireHostOwner } = require("./src/services/host-owner.service.ts");
       const read = userRoutes.stack.find((layer) => layer.route?.path === "/get-mythic-config");
       const write = userRoutes.stack.find((layer) => layer.route?.path === "/update-mythic-config");
       const guarded = read?.route.stack.length === 2 &&
         write?.route.stack[1]?.handle === requireHostOwner;
       process.exit(guarded ? 0 : 1);`,
    ],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("work-host download paths keep shell metacharacters literal", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mythic-download-test-"));
  const execAsync = promisify(exec);
  const runCommand = async (command: string) => {
    try {
      const result = await execAsync(command, { cwd: workspace, shell: "/bin/sh" });
      return { output: `${result.stdout}${result.stderr}`, exitCode: 0 };
    } catch (error: any) {
      return {
        output: `${error?.stdout || ""}${error?.stderr || error?.message || ""}`,
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
  };

  try {
    const savePath = path.join(fs.realpathSync(workspace), "$(touch injected)", "artifact.bin");
    const content = Buffer.from("safe transfer");
    const result = await writeBufferToWorkHost(content, savePath, runCommand);

    assert.equal(result.bytes, content.length, result.output);
    assert.equal(fs.readFileSync(savePath, "utf8"), "safe transfer");
    assert.equal(fs.existsSync(path.join(workspace, "injected")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("work-host downloads support intentional absolute destinations outside the workspace", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mythic-download-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mythic-download-outside-"));
  const execAsync = promisify(exec);
  const runCommand = async (command: string) => {
    try {
      const result = await execAsync(command, { cwd: workspace, shell: "/bin/sh" });
      return { output: `${result.stdout}${result.stderr}`, exitCode: 0 };
    } catch (error: any) {
      return {
        output: `${error?.stdout || ""}${error?.stderr || error?.message || ""}`,
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
  };

  try {
    const destination = path.join(outside, "artifact.bin");
    const result = await writeBufferToWorkHost(
      Buffer.from("outside copy"),
      destination,
      runCommand,
    );
    assert.equal(result.bytes, Buffer.byteLength("outside copy"), result.output);
    assert.equal(fs.readFileSync(destination, "utf8"), "outside copy");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("work-host downloads replace a final symlink without writing through it", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mythic-download-final-link-"));
  const outside = path.join(os.tmpdir(), `mythic-outside-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(outside, "outside stays unchanged");
  const destination = path.join(fs.realpathSync(workspace), "artifact.bin");
  fs.symlinkSync(outside, destination);
  const execAsync = promisify(exec);
  const runCommand = async (command: string) => {
    try {
      const result = await execAsync(command, { cwd: workspace, shell: "/bin/sh" });
      return { output: `${result.stdout}${result.stderr}`, exitCode: 0 };
    } catch (error: any) {
      return {
        output: `${error?.stdout || ""}${error?.stderr || error?.message || ""}`,
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
  };

  try {
    const result = await writeBufferToWorkHost(Buffer.from("workspace copy"), destination, runCommand);
    assert.equal(result.bytes, Buffer.byteLength("workspace copy"), result.output);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(destination, "utf8"), "workspace copy");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside stays unchanged");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("loot upload points follow-up polling at mythic_task_results", async () => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/v1.4/task_upload_file_webhook") {
        res.end(JSON.stringify({ status: "success", agent_file_id: "file-1" }));
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes("query Callback(")) {
        res.end(JSON.stringify({ data: { callback: [{ id: 1, display_id: 7, active: true, host: "target" }] } }));
        return;
      }
      if (body.includes("mutation IssueTask(")) {
        res.end(JSON.stringify({ data: { createTask: { status: "success", display_id: 42 } } }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ errors: [{ message: "unexpected request" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeEnv({ MYTHIC_URL: `http://127.0.0.1:${address.port}`, MYTHIC_API_TOKEN: "mtk_test" });
  let uploadReadCommand = "";

  try {
    const result = await mythicLoot.execute(
      {
        action: "upload_file",
        callback_display_id: 7,
        local_path: "/workspace/$(touch injected).bin",
        remote_path: "C:\\Temp\\payload.bin",
      },
      {
        ...ctx,
        runCommand: async (command: string) => {
          uploadReadCommand = command;
          return { output: Buffer.from("payload").toString("base64"), exitCode: 0 };
        },
      },
    );
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(uploadReadCommand, "base64 -w0 -- '/workspace/$(touch injected).bin'");
    assert.match(result.output, /mythic_task_results action "output"/);
    assert.doesNotMatch(result.output, /mythic_task action "output"/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
