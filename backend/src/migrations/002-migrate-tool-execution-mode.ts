/**
 * Migration: Preserve the legacy "require consent for all tools" setting.
 *
 * Users who enabled the old boolean before toolExecutionMode existed must be
 * moved to requires_consent before the retired field is removed.
 *
 * Usage:
 *   pnpm exec tsx src/migrations/002-migrate-tool-execution-mode.ts
 *
 * Requires MONGO_URI.
 */

import mongoose from "mongoose";

interface UsersCollection {
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }>;
}

export async function migrateToolExecutionMode(collection: UsersCollection) {
  const migrated = await collection.updateMany(
    {
      "configs.requireConsentForAllTools": true,
      "configs.toolExecutionMode": { $exists: false },
    },
    { $set: { "configs.toolExecutionMode": "requires_consent" } },
  );
  const cleaned = await collection.updateMany(
    { "configs.requireConsentForAllTools": { $exists: true } },
    { $unset: { "configs.requireConsentForAllTools": "" } },
  );
  return { migrated: migrated.modifiedCount, cleaned: cleaned.modifiedCount };
}

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }
  await mongoose.connect(mongoUri);
  const result = await migrateToolExecutionMode(
    mongoose.connection.collection("users"),
  );
  console.log(
    `Migrated ${result.migrated} legacy consent setting(s); removed ${result.cleaned} legacy field(s).`,
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
}
