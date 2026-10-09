/**
 * Migration: retire the "Approve for me" execution mode.
 *
 * There used to be three tool execution modes. `auto_approve` sat between them
 * and, instead of asking the operator, sent a boundary-crossing action to a
 * second model that ruled on whether it was safe. The mode is gone: the product
 * now has `auto` (an action the deterministic boundary flags waits for the
 * operator) and `requires_consent` (everything waits). No machine clears a
 * boundary on the operator's behalf any more.
 *
 * A user who had picked `auto_approve` still has that value stored, and the
 * schema enum no longer accepts it — every later `user.save()` would throw, so
 * the setting could not even be changed back from the UI. Those records are
 * moved to `auto`, which is the mode with the same shape: routine actions run,
 * an action the boundary flags stops. The difference is only who is asked —
 * the operator instead of a model.
 *
 * Nothing is deleted, and no capability is lost: `requires_consent` is still
 * there for a user who wants to see every action first.
 *
 * Collection: `users`. Field path: `configs.toolExecutionMode`.
 *
 * Usage (dry run prints what would change and writes nothing):
 *   pnpm exec tsx src/migrations/005-retire-auto-approve-mode.ts
 *   pnpm exec tsx src/migrations/005-retire-auto-approve-mode.ts --apply
 *
 * Requires MONGO_URI.
 */

import mongoose from "mongoose";

/** The removed mode, and the mode its users move to. */
const RETIRED_MODE = "auto_approve";
const REPLACEMENT_MODE = "auto";

interface UsersCollection {
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
}

/** A user still holding the retired mode. */
const HAS_RETIRED_MODE = { "configs.toolExecutionMode": RETIRED_MODE };

export interface RetiredModeAudit {
  users: number;
  usersWithRetiredMode: number;
}

/** Read-only: how many records the migration would touch. */
export async function auditRetiredMode(
  collection: UsersCollection,
): Promise<RetiredModeAudit> {
  const [users, usersWithRetiredMode] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments(HAS_RETIRED_MODE),
  ]);
  return { users, usersWithRetiredMode };
}

/**
 * The migration. Idempotent: a second run matches nothing, because the value
 * has already been replaced.
 */
export async function retireAutoApproveMode(
  collection: UsersCollection,
): Promise<{ migrated: number }> {
  const result = await collection.updateMany(HAS_RETIRED_MODE, {
    $set: { "configs.toolExecutionMode": REPLACEMENT_MODE },
  });
  return { migrated: result.modifiedCount ?? 0 };
}

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }
  const apply = process.argv.includes("--apply");

  await mongoose.connect(mongoUri);
  const collection = mongoose.connection.collection(
    "users",
  ) as unknown as UsersCollection;

  const audit = await auditRetiredMode(collection);
  console.log("Retire 'Approve for me' — audit");
  console.log(`  users                        : ${audit.users}`);
  console.log(`  users still on auto_approve  : ${audit.usersWithRetiredMode}`);

  if (!apply) {
    console.log("");
    console.log(
      `DRY RUN — nothing was written. Re-run with --apply to move them to "${REPLACEMENT_MODE}".`,
    );
    await mongoose.disconnect();
    return;
  }

  const result = await retireAutoApproveMode(collection);
  console.log("");
  console.log(`  moved to "${REPLACEMENT_MODE}"           : ${result.migrated}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
