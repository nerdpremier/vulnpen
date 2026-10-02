#!/usr/bin/env node
/**
 * Clean legacy risk-scoring data out of session vulnerabilities.
 *
 * Severity is now derived from the risk matrix (likelihood x impact, equal
 * weight) and CVSS, ASVS and the OWASP API Security Top 10:2023 have been
 * removed from the system. This script, per finding in every session:
 *
 *   1. $unset the removed fields: cvssScore, cvssVector, apiRisk, asvsRequirement.
 *   2. Recomputes severity from the stored likelihood/impactRating factors with
 *      the same matrix the service uses (3x3 = high, high x medium = medium,
 *      anything low x = low; missing factors = info). Any stored severity word
 *      is discarded on purpose — a declared word is no longer authoritative.
 *
 * It is idempotent: re-running it makes no further changes once every finding
 * has been cleaned, and it never touches anything outside the vulnerabilities
 * arrays.
 *
 * Run it inside the backend container, where MONGO_URI is already configured:
 *
 *   node scripts/migrate-risk-matrix.mjs           # dry run, prints the plan
 *   node scripts/migrate-risk-matrix.mjs --yes     # performs the cleanup
 *
 * With Docker Compose:
 *
 *   docker compose exec backend node scripts/migrate-risk-matrix.mjs --yes
 */

import mongoose from "mongoose";

const args = process.argv.slice(2);

function readFlag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const database = String(readFlag("db", process.env.MONGO_DATABASE || "vulnpen"));
const uri = String(
  readFlag("uri", process.env.MONGO_URI || "mongodb://127.0.0.1:27017"),
);
const confirmed = readFlag("yes", false) === true;

const REMOVED_FIELDS = ["cvssScore", "cvssVector", "apiRisk", "asvsRequirement"];

function log(message) {
  console.log(`[migrate:risk-matrix] ${message}`);
}

/** Same bands as knowledge/practitioner-workflow.ts wstgRiskRating(). */
function riskRating(likelihood, impactRating) {
  if (!Number.isFinite(likelihood) || !Number.isFinite(impactRating)) return "info";
  const l = Math.min(3, Math.max(1, Math.round(likelihood)));
  const i = Math.min(3, Math.max(1, Math.round(impactRating)));
  if (l >= 3) return i >= 3 ? "high" : i >= 2 ? "medium" : "low";
  if (l === 2) return i >= 2 ? "medium" : "low";
  return "low";
}

async function main() {
  log(`database        : ${database}`);
  log(`mongo uri       : ${uri.replace(/\/\/[^@]*@/, "//***@")}`);

  if (!confirmed) {
    log("dry run - nothing was written. Re-run with --yes to perform the cleanup.");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.useDb(database, { useCache: false }).db;
  const sessions = db.collection("sessions");

  const cursor = sessions.find(
    { vulnerabilities: { $exists: true, $ne: [] } },
    { projection: { sessionId: 1, vulnerabilities: 1 } },
  );

  let sessionCount = 0;
  let findingCount = 0;
  let severityRewritten = 0;

  for await (const session of cursor) {
    sessionCount += 1;
    const updates = [];

    for (const finding of session.vulnerabilities ?? []) {
      findingCount += 1;
      const nextSeverity = riskRating(finding.likelihood, finding.impactRating);
      const severityChanged = (finding.severity ?? "info") !== nextSeverity;
      const hasRemovedField = REMOVED_FIELDS.some((field) => finding[field] !== undefined);

      if (!severityChanged && !hasRemovedField) continue;
      if (severityChanged) severityRewritten += 1;

      const set = severityChanged ? { "vulnerabilities.$.severity": nextSeverity } : {};
      const unset = {};
      for (const field of REMOVED_FIELDS) {
        if (finding[field] !== undefined) unset[`vulnerabilities.$.${field}`] = "";
      }
      updates.push(
        confirmed
          ? { updateOne: { filter: { _id: session._id, "vulnerabilities.vulnerabilityId": finding.vulnerabilityId }, update: { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) } } }
          : null,
      );
    }

    if (confirmed && updates.length) {
      await sessions.bulkWrite(updates, { ordered: false });
    }
  }

  log(`scanned ${sessionCount} session(s) with ${findingCount} finding(s)`);
  log(`${severityRewritten} finding(s) get their severity recomputed from the risk matrix`);
  log(`${REMOVED_FIELDS.join(", ")} fields are dropped wherever present`);
  if (confirmed) {
    log("done - legacy risk-scoring data removed.");
  } else {
    log("dry run finished - no changes were made.");
  }
}

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(process.exitCode || 0))
  .catch(async (error) => {
    console.error(`[migrate:risk-matrix] failed: ${error?.message ?? error}`);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore: the connection may never have been established
    }
    process.exit(1);
  });
