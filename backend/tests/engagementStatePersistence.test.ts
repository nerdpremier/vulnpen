import { test } from "node:test";
import assert from "node:assert/strict";
import updateEngagementState from "../src/tools/handlers/update-engagement-state";
import {
  EngagementState,
  engagementStateFromSession,
  EngagementStateSnapshot,
} from "../src/services/engagement-state";

function context(state: EngagementState): any {
  return {
    sessionId: "test-session",
    agentId: "test-agent",
    agentRole: "main",
    engagementState: state,
  };
}

test("a successful update_engagement_state flushes the snapshot to the persister", async () => {
  const snapshots: EngagementStateSnapshot[] = [];
  const state = new EngagementState("pentest", async (snapshot) => {
    snapshots.push(snapshot);
  });

  await updateEngagementState.execute(
    { action: "add_host", data: { ip: "10.0.0.5", status: "up" } },
    context(state),
  );
  await updateEngagementState.execute(
    { action: "add_credential", data: { username: "admin", secret: "hunter2" } },
    context(state),
  );

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].hosts[0].ip, "10.0.0.5");
  assert.equal(snapshots[0].hosts[0].status, "up");
  assert.equal(snapshots[1].credentials[0].username, "admin");
  // The host from the first call is still in the latest snapshot.
  assert.equal(snapshots[1].hosts.length, 1);
});

test("a failed update does not flush", async () => {
  const snapshots: EngagementStateSnapshot[] = [];
  const state = new EngagementState("pentest", async (snapshot) => {
    snapshots.push(snapshot);
  });

  await updateEngagementState.execute(
    { action: "add_key_discovery", data: {} },
    context(state),
  );

  assert.equal(snapshots.length, 0);
  assert.equal(state.keyDiscoveries.length, 0);
});

test("state rebuilt from a session document restores the snapshot and merges new findings", async () => {
  const snapshots: EngagementStateSnapshot[] = [];
  const session = {
    sessionId: "persisted-session",
    engagementContext: { target: "shop.example.test", scope: "shop.example.test" },
    vulnerabilities: [],
    engagementState: {
      hosts: [{ ip: "10.0.0.5", status: "up" }],
      services: [{ host: "10.0.0.5", port: 443, protocol: "tcp", service: "https" }],
      credentials: [],
      shells: [],
      implants: [],
      keyDiscoveries: ["Admin panel at /admin"],
      files: [],
      approachesTried: [],
      nextSteps: [],
    },
  };

  const state = engagementStateFromSession(session, async (snapshot) => {
    snapshots.push(snapshot);
  });
  assert.equal(state.declaredTarget, "shop.example.test");
  assert.deepEqual(state.hosts, session.engagementState.hosts);
  assert.deepEqual(state.services, session.engagementState.services);
  assert.deepEqual(state.keyDiscoveries, session.engagementState.keyDiscoveries);

  await updateEngagementState.execute(
    { action: "add_key_discovery", data: { title: "New", description: "Finding" } },
    context(state),
  );
  await state.flush();

  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].keyDiscoveries, [
    "Admin panel at /admin",
    "New: Finding",
  ]);
  assert.equal(snapshots[0].hosts.length, 1);
});

test("a session document without a snapshot still wires the persister for later writes", async () => {
  const snapshots: EngagementStateSnapshot[] = [];
  const state = engagementStateFromSession(
    { sessionId: "fresh-session", engagementContext: { target: "t" } },
    async (snapshot) => {
      snapshots.push(snapshot);
    },
  );

  await updateEngagementState.execute(
    { action: "add_host", data: { ip: "10.0.0.9" } },
    context(state),
  );
  await state.flush();

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].hosts[0].ip, "10.0.0.9");
  assert.equal(snapshots[0].hosts[0].status, "up");
});

test("state without a persister flushes as a no-op", async () => {
  const state = new EngagementState("pentest");
  await updateEngagementState.execute(
    { action: "add_host", data: { ip: "10.0.0.9" } },
    context(state),
  );
  await state.flush();
  assert.equal(state.hosts.length, 1);
});
