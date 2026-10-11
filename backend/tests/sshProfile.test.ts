import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSSHConfigAliases,
  parseSSHGOutput,
  LEGACY_PROFILE_ALIAS,
  listSSHProfiles,
} from "../src/services/ssh-profile.service";
import { ShellManager } from "../src/services/shell.manager";
import {
  normalizeWorkHost,
  resolveWorkHostRecords,
  shellFolderExpression,
  validateWorkFolder,
} from "../src/services/work-host.service";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("discovers only concrete SSH host aliases", () => {
  const aliases = parseSSHConfigAliases(`
Host box-a box-b
  HostName 10.0.0.1
Host *.internal !blocked.internal
  User root
Host box-c
  HostName example.test
`);
  assert.deepEqual(aliases, ["box-a", "box-b", "box-c"]);
});

test("parses repeated ssh -G fields", () => {
  const parsed = parseSSHGOutput(`
host box-a
hostname 10.0.0.1
user admin
port 2222
identityfile ~/.ssh/id_ed25519
identityfile ~/.ssh/id_rsa
`);
  assert.equal(parsed.hostname[0], "10.0.0.1");
  assert.equal(parsed.user[0], "admin");
  assert.deepEqual(parsed.identityfile, ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"]);
});

test("discovers aliases from common Include globs", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pc-ssh-include-"));
  const previousConfig = process.env.SSH_CONFIG_FILE;
  try {
    await fs.promises.mkdir(path.join(root, "config.d"));
    await fs.promises.writeFile(
      path.join(root, "config"),
      "Include config.d/*\n",
    );
    await fs.promises.writeFile(
      path.join(root, "config.d", "lab.conf"),
      "Host included-lab\n  HostName 192.0.2.10\n  User tester\n",
    );
    process.env.SSH_CONFIG_FILE = path.join(root, "config");
    const profiles = await listSSHProfiles();
    assert.equal(profiles.some((profile) => profile.alias === "included-lab"), true);
  } finally {
    if (previousConfig === undefined) delete process.env.SSH_CONFIG_FILE;
    else process.env.SSH_CONFIG_FILE = previousConfig;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

const stubResolver = async (alias: string) => ({
  summary: { alias, label: alias, host: "10.0.0.7", port: 22, username: "tester", source: "ssh_config" as const, available: true },
  config: { host: "10.0.0.7", port: 22, username: "tester", privateKey: "not-persisted" },
});

test("sessions in one workspace resolve the same host and folder", async () => {
  const workspace = {
    workspaceId: "workspace-one",
    workHost: { kind: "ssh" as const, workFolder: "/tmp/work folder", sshProfileAlias: "kali-lab" },
  };
  const first = await resolveWorkHostRecords({ workspaceId: "workspace-one" }, workspace, stubResolver);
  const second = await resolveWorkHostRecords({ workspaceId: "workspace-one" }, workspace, stubResolver);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "ssh");
  assert.equal(first.workFolder, "/tmp/work folder");
});

test("session to workspace resolution rejects mismatched records", async () => {
  await assert.rejects(
    resolveWorkHostRecords(
      { workspaceId: "workspace-one" },
      { workspaceId: "workspace-two", workHost: { kind: "ssh", workFolder: "/tmp/work", sshProfileAlias: "x" } },
      stubResolver,
    ),
    /does not belong/,
  );
});

test("the agent never runs inside the backend: a local work host is refused everywhere", async () => {
  await assert.rejects(normalizeWorkHost("w", { kind: "local", workFolder: "/tmp/w" }), /attack box/);

  const previous = { host: process.env.SSH_HOST, user: process.env.SSH_USERNAME };
  try {
    // A record saved before local execution was retired, and no attack box configured.
    delete process.env.SSH_HOST;
    delete process.env.SSH_USERNAME;
    await assert.rejects(
      resolveWorkHostRecords(
        { workspaceId: "w" },
        { workspaceId: "w", workHost: { kind: "local", workFolder: "/tmp/w" } },
        stubResolver,
      ),
      /attack box/,
    );
    await assert.rejects(
      resolveWorkHostRecords({ workspaceId: "w" }, { workspaceId: "w" }, stubResolver),
      /attack box/,
    );

    // With the environment's attack box configured the same record resolves to it.
    process.env.SSH_HOST = "kali";
    process.env.SSH_USERNAME = "root";
    const target = await resolveWorkHostRecords(
      { workspaceId: "w" },
      { workspaceId: "w", workHost: { kind: "local", workFolder: "/tmp/w" } },
      stubResolver,
    );
    assert.equal(target.kind, "ssh");
    assert.equal(target.sshProfileAlias, LEGACY_PROFILE_ALIAS);
    assert.notEqual(target.workFolder, "/tmp/w");
  } finally {
    if (previous.host === undefined) delete process.env.SSH_HOST;
    else process.env.SSH_HOST = previous.host;
    if (previous.user === undefined) delete process.env.SSH_USERNAME;
    else process.env.SSH_USERNAME = previous.user;
  }
});

test("a shell manager refuses a local target instead of spawning a process", async () => {
  const manager = new ShellManager("s", async () => ({
    workspaceId: "w",
    kind: "local" as unknown as "ssh",
    workFolder: "/tmp/w",
  }));
  await assert.rejects(manager.connect(), /attack box/);
  assert.equal(manager.isConnected, false);
});

test("SSH work host stores an alias and resolves credentials outside Mongo", async () => {
  const target = await resolveWorkHostRecords(
    { workspaceId: "workspace-one" },
    {
      workspaceId: "workspace-one",
      workHost: { kind: "ssh", workFolder: "~/client work", sshProfileAlias: "kali-lab" },
    },
    async (alias) => ({
      summary: { alias, label: alias, host: "10.0.0.7", port: 22, username: "tester", source: "ssh_config", available: true },
      config: { host: "10.0.0.7", port: 22, username: "tester", privateKey: "not-persisted" },
    }),
  );
  assert.equal(target.sshProfileAlias, "kali-lab");
  assert.equal(target.sshConfig?.privateKey, "not-persisted");
});

test("work folder validation and quoting preserve spaces and remote home expansion", () => {
  assert.equal(validateWorkFolder("~/client work/"), "~/client work");
  assert.equal(shellFolderExpression("~/client work"), '"$HOME"/\'client work\'');
  assert.equal(shellFolderExpression("/tmp/a'b"), "'/tmp/a'\\''b'");
  assert.throws(() => validateWorkFolder("relative/path"), /absolute path/);
  assert.throws(() => validateWorkFolder("/tmp/a\ncmd"), /invalid/);
});

