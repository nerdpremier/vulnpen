/**
 * Migration: drop the legacy OWASP mapping fields.
 *
 * The OWASP Top 10:2025 classification used to be produced by a cascade —
 * tester override, then this project's curated WSTG crosswalk, then a CWE, then
 * an LLM classifier — and a finding carried two fields that only existed to
 * serve it: `owaspRelated` (the extra categories the cascade listed alongside
 * the primary) and `owaspConfidence`. The cascade is gone. A finding is now
 * classified by looking its CWE up in the CWE lists OWASP publishes, and
 * nothing else, so both fields are dead weight.
 *
 * Classifications written by the removed layers have to go with them. They are
 * identifiable by provenance: a stored category whose `owaspProvenance` is not
 * "official" came from the crosswalk, a tester decision or the model, and is a
 * claim this system no longer makes. Clearing it lets the derivation re-fill it
 * from the finding's CWE on the next read (see `refreshOwaspClassifications`).
 * A finding that then has no derivable category stays unmapped, which is the
 * honest result.
 *
 * Collection: `sessions`. Field paths: `vulnerabilities[].<field>`.
 *
 * Usage (dry run prints what would change and writes nothing):
 *   pnpm exec tsx src/migrations/004-drop-legacy-owasp-mapping-fields.ts
 *   pnpm exec tsx src/migrations/004-drop-legacy-owasp-mapping-fields.ts --apply
 *
 * Requires MONGO_URI.
 */

import mongoose from "mongoose";

/** Fields the schema no longer defines: removed outright. */
const DROPPED_FIELDS = ["owaspRelated", "owaspConfidence"] as const;

/** The classification fields a non-official mapping must give up. */
const CLASSIFICATION_FIELDS = [
  "owaspTop10",
  "owaspTop10Title",
  "owaspProvenance",
  "owaspRationale",
  "owaspMappedAt",
] as const;

/** A finding still carrying either dropped field. */
const HAS_DROPPED_FIELD = {
  $or: DROPPED_FIELDS.map((field) => ({
    [`vulnerabilities.${field}`]: { $exists: true },
  })),
};

/** A finding whose stored category was not produced by the official lookup. */
const HAS_NON_OFFICIAL_MAPPING = {
  vulnerabilities: {
    $elemMatch: {
      owaspTop10: { $exists: true },
      owaspProvenance: { $ne: "official" },
    },
  },
};

const NON_OFFICIAL_ELEMENT = {
  "finding.owaspTop10": { $exists: true },
  "finding.owaspProvenance": { $ne: "official" },
};

interface SessionsCollection {
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  aggregate(pipeline: Record<string, unknown>[]): { toArray(): Promise<any[]> };
}

export interface LegacyOwaspAudit {
  sessions: number;
  sessionsWithFindings: number;
  sessionsWithDroppedFields: number;
  sessionsWithNonOfficialMapping: number;
  findings: number;
  findingsWithDroppedFields: number;
  findingsWithNonOfficialMapping: number;
}

/**
 * Read-only: what the migration would touch. Run this first — it is the
 * "confirm safety" step, and it changes nothing.
 */
export async function auditLegacyOwaspMapping(
  collection: SessionsCollection,
): Promise<LegacyOwaspAudit> {
  const [sessions, sessionsWithFindings, sessionsWithDroppedFields, sessionsWithNonOfficialMapping] =
    await Promise.all([
      collection.countDocuments({}),
      collection.countDocuments({ "vulnerabilities.0": { $exists: true } }),
      collection.countDocuments(HAS_DROPPED_FIELD),
      collection.countDocuments(HAS_NON_OFFICIAL_MAPPING),
    ]);

  const [counts] = await collection
    .aggregate([
      { $unwind: "$vulnerabilities" },
      {
        $group: {
          _id: null,
          findings: { $sum: 1 },
          findingsWithDroppedFields: {
            $sum: {
              $cond: [
                {
                  $or: DROPPED_FIELDS.map((field) => ({
                    $ne: [{ $type: `$vulnerabilities.${field}` }, "missing"],
                  })),
                },
                1,
                0,
              ],
            },
          },
          findingsWithNonOfficialMapping: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: [{ $type: "$vulnerabilities.owaspTop10" }, "missing"] },
                    { $ne: ["$vulnerabilities.owaspProvenance", "official"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ])
    .toArray();

  return {
    sessions,
    sessionsWithFindings,
    sessionsWithDroppedFields,
    sessionsWithNonOfficialMapping,
    findings: counts?.findings ?? 0,
    findingsWithDroppedFields: counts?.findingsWithDroppedFields ?? 0,
    findingsWithNonOfficialMapping: counts?.findingsWithNonOfficialMapping ?? 0,
  };
}

export interface LegacyOwaspResult {
  sessionsWithDroppedFields: number;
  sessionsWithNonOfficialMapping: number;
}

/**
 * The migration. Idempotent: a second run matches nothing. Returns the number
 * of session documents each step modified.
 */
export async function dropLegacyOwaspMappingFields(
  collection: SessionsCollection,
): Promise<LegacyOwaspResult> {
  // `$[]` reaches every element of the array, and `$unset` on an absent path is
  // a no-op, so this is safe for findings that never carried the field.
  const dropped = await collection.updateMany(HAS_DROPPED_FIELD, {
    $unset: Object.fromEntries(
      DROPPED_FIELDS.map((field) => [`vulnerabilities.$[].${field}`, ""]),
    ),
  });

  // `$[finding]` is filtered, so only findings that actually hold a
  // non-official classification lose one; the rest of the document is untouched.
  const cleared = await collection.updateMany(
    HAS_NON_OFFICIAL_MAPPING,
    {
      $unset: Object.fromEntries(
        CLASSIFICATION_FIELDS.map((field) => [`vulnerabilities.$[finding].${field}`, ""]),
      ),
    },
    { arrayFilters: [NON_OFFICIAL_ELEMENT] },
  );

  return {
    sessionsWithDroppedFields: dropped.modifiedCount ?? 0,
    sessionsWithNonOfficialMapping: cleared.modifiedCount ?? 0,
  };
}

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }
  const apply = process.argv.includes("--apply");

  await mongoose.connect(mongoUri);
  const collection = mongoose.connection.collection(
    "sessions",
  ) as unknown as SessionsCollection;

  const audit = await auditLegacyOwaspMapping(collection);
  console.log("Legacy OWASP mapping fields — audit");
  console.log(`  sessions                                  : ${audit.sessions}`);
  console.log(`  sessions with findings                    : ${audit.sessionsWithFindings}`);
  console.log(`  sessions with owaspRelated/Confidence      : ${audit.sessionsWithDroppedFields}`);
  console.log(`  sessions with a non-official classification: ${audit.sessionsWithNonOfficialMapping}`);
  console.log(`  findings                                   : ${audit.findings}`);
  console.log(`  findings with owaspRelated/Confidence      : ${audit.findingsWithDroppedFields}`);
  console.log(`  findings with a non-official classification: ${audit.findingsWithNonOfficialMapping}`);

  if (!apply) {
    console.log("");
    console.log("DRY RUN — nothing was written. Re-run with --apply to migrate.");
    await mongoose.disconnect();
    return;
  }

  const result = await dropLegacyOwaspMappingFields(collection);
  console.log("");
  console.log(
    `Applied: ${result.sessionsWithDroppedFields} session(s) had the dropped fields removed, ` +
      `${result.sessionsWithNonOfficialMapping} session(s) had non-official classifications cleared.`,
  );
  console.log(
    "Cleared classifications are re-derived from the finding's CWE on the next read " +
      "(refreshOwaspClassifications); findings with no derivable category stay unmapped.",
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
}
