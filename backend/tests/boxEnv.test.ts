import { test } from "node:test";
import assert from "node:assert/strict";
import { probeBoxEnv } from "../src/services/box-env";
import type { ShellManager } from "../src/services/shell.manager";

function fakeShell(overrides: {
  isConnected?: boolean;
  output?: string;
  error?: Error;
  remoteWorkspaceDir?: string;
}): ShellManager {
  return {
    isConnected: overrides.isConnected ?? true,
    remoteWorkspaceDir: overrides.remoteWorkspaceDir ?? "~/workspace",
    execInShell: async () => {
      if (overrides.error) throw overrides.error;
      return { output: overrides.output ?? "", exitCode: 0 };
    },
  } as unknown as ShellManager;
}

test("probeBoxEnv: disconnected shell skips the probe entirely", async () => {
  let probed = false;
  const shell = {
    isConnected: false,
    remoteWorkspaceDir: "~/workspace",
    execInShell: async () => {
      probed = true;
      return { output: "", exitCode: 0 };
    },
  } as unknown as ShellManager;

  assert.equal(await probeBoxEnv(shell), undefined);
  assert.equal(probed, false);
});

test("probeBoxEnv: parses the delimited output and resolves ~ against the probed home", async () => {
  const env = await probeBoxEnv(
    fakeShell({
      output: "root|||/root|||Linux|||x86_64",
      remoteWorkspaceDir: "~/work",
    }),
  );

  assert.deepEqual(env, {
    user: "root",
    home: "/root",
    os: "Linux (x86_64)",
    workspacePath: "/root/work",
  });
});

test("probeBoxEnv: an absolute workspace dir is left untouched", async () => {
  const env = await probeBoxEnv(
    fakeShell({
      output: "kali|||/home/kali|||Linux|||aarch64",
      remoteWorkspaceDir: "/opt/engagements",
    }),
  );

  assert.equal(env?.workspacePath, "/opt/engagements");
});

test("probeBoxEnv: unparseable output yields undefined, not a half-built env", async () => {
  assert.equal(await probeBoxEnv(fakeShell({ output: "root|||/root" })), undefined);
  assert.equal(await probeBoxEnv(fakeShell({ output: "" })), undefined);
});

test("probeBoxEnv: a probe failure yields undefined instead of throwing", async () => {
  const env = await probeBoxEnv(
    fakeShell({ error: new Error("SSH channel closed") }),
  );
  assert.equal(env, undefined);
});
