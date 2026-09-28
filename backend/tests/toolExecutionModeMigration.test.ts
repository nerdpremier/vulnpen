import assert from "node:assert/strict";
import test from "node:test";
import { migrateToolExecutionMode } from "../src/migrations/002-migrate-tool-execution-mode";
import { resolveToolExecutionMode } from "../src/models/User/User.model";

test("legacy consent remains effective before the migration runs", () => {
  assert.equal(
    resolveToolExecutionMode({ requireConsentForAllTools: true }),
    "requires_consent",
  );
  assert.equal(
    resolveToolExecutionMode({
      requireConsentForAllTools: true,
      toolExecutionMode: "auto_approve",
    }),
    "auto_approve",
  );
  assert.equal(resolveToolExecutionMode({}), "auto");
});

test("legacy consent users are migrated without overriding explicit modes", async () => {
  const users = [
    { configs: { requireConsentForAllTools: true } },
    { configs: { requireConsentForAllTools: false } },
    {
      configs: {
        requireConsentForAllTools: true,
        toolExecutionMode: "auto",
      },
    },
  ];
  const collection = {
    async updateMany(filter: any, update: any) {
      let modifiedCount = 0;
      for (const user of users) {
        const configs = user.configs as Record<string, unknown>;
        const matchesMigration =
          filter["configs.requireConsentForAllTools"] === true &&
          configs.requireConsentForAllTools === true &&
          !("toolExecutionMode" in configs);
        const matchesCleanup =
          filter["configs.requireConsentForAllTools"]?.$exists === true &&
          "requireConsentForAllTools" in configs;
        if (!matchesMigration && !matchesCleanup) continue;
        if (update.$set) {
          configs.toolExecutionMode = update.$set["configs.toolExecutionMode"];
        }
        if (update.$unset) delete configs.requireConsentForAllTools;
        modifiedCount++;
      }
      return { modifiedCount };
    },
  };

  const result = await migrateToolExecutionMode(collection);

  assert.deepEqual(result, { migrated: 1, cleaned: 3 });
  assert.deepEqual(users, [
    { configs: { toolExecutionMode: "requires_consent" } },
    { configs: {} },
    { configs: { toolExecutionMode: "auto" } },
  ]);
});
