/**
 * Migration: Create Workspace documents for all existing Sessions.
 *
 * For each Session that does not yet have a workspaceId, this script:
 *   1. Creates a Workspace (same name / description / uid).
 *   2. Sets session.workspaceId to the new workspace's workspaceId.
 *
 * Safe to run multiple times — skips sessions that already have a workspaceId.
 *
 * Usage:
 *   npx ts-node src/migrations/001-create-workspaces.ts
 *
 * Requires MONGO_URI environment variable (or the secrets system).
 */

import mongoose from "mongoose";

export async function migrateSessionsToWorkspaces() {
  const SessionsModel = (await import("../models/Sessions/Sessions.model")).default;
  const WorkspaceModel = (await import("../models/Workspace/Workspace.model")).default;

  const sessions = await SessionsModel.find({
    $or: [{ workspaceId: { $exists: false } }, { workspaceId: "" }],
  });

  console.log(`Found ${sessions.length} session(s) without a workspace`);

  let created = 0;
  for (const session of sessions) {
    const workspaceId = `legacy-${session.sessionId}`;

    await WorkspaceModel.updateOne(
      { workspaceId },
      {
        $setOnInsert: {
          uid: session.uid,
          workspaceId,
          name: session.name,
          description: session.description || "",
          type: "pentest",
          createdAt: session.createdAt,
          status: session.status,
        },
      },
      { upsert: true },
    );
    await SessionsModel.updateOne(
      { _id: session._id },
      { $set: { workspaceId } },
    );

    created++;
    console.log(`  [${created}] Session "${session.name}" (${session.sessionId}) -> Workspace ${workspaceId}`);
  }

  return { created };
}

async function run() {
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) throw new Error("MONGO_URI environment variable is required");
  await mongoose.connect(MONGO_URI);
  const result = await migrateSessionsToWorkspaces();
  console.log(`Done. Created ${result.created} workspace(s).`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
