#!/usr/bin/env node
/**
 * Copy data from a previous database name into the current one.
 *
 * VulnPen keeps everything in a MongoDB database called `vulnpen` unless you
 * pass --to. Installations from earlier releases may still store their data
 * under a different database name, so this script copies every collection -
 * documents and indexes - across. It is idempotent (documents are upserted by
 * _id, so re-running it is safe) and it never writes to or drops the source
 * database, which stays in place as your rollback.
 *
 * The source database is detected automatically when the server holds exactly
 * one other database. Otherwise pass it with --from (or LEGACY_MONGO_DATABASE).
 *
 * Run it inside the backend container, where MONGO_URI is already configured:
 *
 *   node scripts/migrate-database-name.mjs                      # dry run, prints the plan
 *   node scripts/migrate-database-name.mjs --yes                # performs the copy
 *   node scripts/migrate-database-name.mjs --yes --from <name>  # explicit source
 *   node scripts/migrate-database-name.mjs --yes --to vulnpen --uri mongodb://127.0.0.1:27017
 *
 * With Docker Compose:
 *
 *   docker compose exec backend node scripts/migrate-database-name.mjs --yes
 */

import mongoose from "mongoose";

const args = process.argv.slice(2);

function readFlag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const requestedSource = String(readFlag("from", process.env.LEGACY_MONGO_DATABASE || ""));
const to = String(readFlag("to", process.env.MONGO_DATABASE || "vulnpen"));
const uri = String(
  readFlag("uri", process.env.MONGO_URI || "mongodb://127.0.0.1:27017"),
);
const confirmed = readFlag("yes", false) === true;
const batchSize = Number(readFlag("batch", 500)) || 500;
const SYSTEM_DATABASES = ["admin", "local", "config"];

function log(message) {
  console.log(`[migrate:db-name] ${message}`);
}

function indexOptions(index) {
  const options = { name: index.name };
  for (const key of ["unique", "sparse", "background", "expireAfterSeconds", "partialFilterExpression", "collation"]) {
    if (index[key] !== undefined) options[key] = index[key];
  }
  return options;
}

async function detectSource(targetName) {
  if (requestedSource) {
    log(`source database : ${requestedSource}`);
    return requestedSource;
  }

  let candidates;
  try {
    const admin = mongoose.connection.useDb("admin", { useCache: false }).db.admin();
    const listing = await admin.listDatabases();
    candidates = listing.databases
      .map((entry) => entry.name)
      .filter(
        (name) =>
          !SYSTEM_DATABASES.includes(name) && name !== targetName && !name.startsWith("system."),
      );
  } catch (error) {
    log(`could not list databases automatically: ${error?.message ?? error}`);
    log("re-run with --from <name> (or set LEGACY_MONGO_DATABASE) to pick the source database.");
    process.exitCode = 1;
    return null;
  }

  if (candidates.length === 1) {
    log(`source database : ${candidates[0]} (auto-detected)`);
    return candidates[0];
  }

  if (candidates.length === 0) {
    log(`no other database next to "${targetName}" - nothing to migrate.`);
    return null;
  }

  log(`several databases could be the source: ${candidates.join(", ")}`);
  log("re-run with --from <name> (or set LEGACY_MONGO_DATABASE) to pick one.");
  process.exitCode = 1;
  return null;
}

async function main() {
  log(`target database : ${to}`);
  log(`mongo uri       : ${uri.replace(/\/\/[^@]*@/, "//***@")}`);

  if (!confirmed) {
    log("dry run - nothing was written. Re-run with --yes to perform the copy.");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const target = mongoose.connection.useDb(to, { useCache: false });
  const from = await detectSource(to);

  if (!from || from === to) {
    if (from === to) log("source and target are the same database; nothing to do.");
    return;
  }

  const source = mongoose.connection.useDb(from, { useCache: false });
  const collections = (await source.db.listCollections().toArray())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("system."))
    .sort();

  if (collections.length === 0) {
    log(`no collections found in "${from}" - nothing to migrate.`);
    return;
  }

  let copiedDocuments = 0;
  let copiedIndexes = 0;

  for (const name of collections) {
    const sourceCount = await source.db.collection(name).countDocuments();
    const targetCount = await target.db.collection(name).countDocuments();
    log(`${name}: ${sourceCount} document(s) in source, ${targetCount} already in target`);

    if (!confirmed) continue;

    const cursor = source.db.collection(name).find({});
    let batch = [];
    let written = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      const operations = batch.map((document) => ({
        replaceOne: {
          filter: { _id: document._id },
          replacement: document,
          upsert: true,
        },
      }));
      const result = await target.db.collection(name).bulkWrite(operations, { ordered: false });
      written += (result.upsertedCount || 0) + (result.modifiedCount || 0);
      batch = [];
    };

    for await (const document of cursor) {
      batch.push(document);
      if (batch.length >= batchSize) await flush();
    }
    await flush();

    const indexes = await source.db.collection(name).indexes();
    for (const index of indexes) {
      if (index.name === "_id_") continue;
      await target.db.collection(name).createIndex(index.key, indexOptions(index));
      copiedIndexes += 1;
    }

    copiedDocuments += written;
    log(`${name}: wrote ${written} document(s), ${indexes.length - 1} index(es)`);
  }

  if (confirmed) {
    log(
      `done - ${copiedDocuments} document(s) and ${copiedIndexes} index(es) copied into "${to}".`,
    );
    log(
      `the source database "${from}" was not modified. Once you have verified the app, drop it manually if you want the space back:`,
    );
    log(`  mongosh --eval 'db.getSiblingDB("${from}").dropDatabase()'`);
  } else {
    log("dry run finished - no changes were made.");
  }
}

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(process.exitCode || 0))
  .catch(async (error) => {
    console.error(`[migrate:db-name] failed: ${error?.message ?? error}`);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore: the connection may never have been established
    }
    process.exit(1);
  });