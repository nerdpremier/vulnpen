/**
 * Migration: Repair tool calls stored with empty arguments.
 *
 * A provider stream can deliver a tool call with no argument chunks; the
 * collector used to join those chunks into `""`, and `""` is not "no
 * arguments" — Mongoose reads it as a missing value for the required
 * `arguments` path. Because opening a turn saves the whole session document,
 * one such message made every later save of that session throw
 * "Session validation failed", which surfaced as
 * `[wstg-run] error: Session validation failed: messages.N.toolCalls.0.arguments:
 * Path \`arguments\` is required` and permanently broke the scan queue for that
 * session. The assembly seams now emit `{}` (see toolCallArguments) and the
 * schema setter blocks new empty values; this repairs documents already stored.
 *
 * Usage:
 *   pnpm exec tsx src/migrations/003-repair-empty-tool-call-arguments.ts
 *
 * Requires MONGO_URI.
 */

import mongoose from "mongoose";

interface SessionsCollection {
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }>;
}

const EMPTY_ARGUMENT = { $in: ["", null] };

/** A tool-call array that actually contains a call to repair. */
const HAS_EMPTY_CALL = { $elemMatch: { arguments: EMPTY_ARGUMENT } };

/**
 * The two places a session keeps tool calls.
 *
 * Every path here is written the strict way, because the loose version crashes
 * the boot: MongoDB reads `{"a.b": null}` as "missing or null", so a bare
 * `{"messages.toolCalls.arguments": {$in: ["", null]}}` filter also selects
 * sessions whose messages simply have no tool calls at all — and the update
 * path then aborts the whole operation with "The path 'messages' must exist in
 * the document in order to apply array updates". `$elemMatch` requires the
 * array to exist, both in the document filter and in each arrayFilter, so the
 * segment after every `$[...]` is guaranteed to resolve.
 *
 * An update path cannot skip an array level either: MongoDB rejects
 * `subagents.messages.$[message]` with "The path 'subagents.messages' must
 * exist", so the nested transcript names every array it crosses.
 */
const TOOL_CALL_PATHS = [
  {
    filter: { messages: { $elemMatch: { toolCalls: HAS_EMPTY_CALL } } },
    updatePath: "messages.$[message].toolCalls.$[call].arguments",
    arrayFilters: [
      { "message.toolCalls": HAS_EMPTY_CALL },
      { "call.arguments": EMPTY_ARGUMENT },
    ],
  },
  {
    filter: {
      subagents: {
        $elemMatch: { messages: { $elemMatch: { toolCalls: HAS_EMPTY_CALL } } },
      },
    },
    updatePath:
      "subagents.$[subagent].messages.$[message].toolCalls.$[call].arguments",
    arrayFilters: [
      { "subagent.messages": { $elemMatch: { toolCalls: HAS_EMPTY_CALL } } },
      { "message.toolCalls": HAS_EMPTY_CALL },
      { "call.arguments": EMPTY_ARGUMENT },
    ],
  },
] as const;

export async function repairEmptyToolCallArguments(
  collection: SessionsCollection,
): Promise<{ repaired: number }> {
  let repaired = 0;

  // Each path reports the documents it touched, so a session with bad calls in
  // both its own transcript and a subagent's counts once per transcript.
  for (const { filter, updatePath, arrayFilters } of TOOL_CALL_PATHS) {
    const result = await collection.updateMany(
      filter,
      { $set: { [updatePath]: "{}" } },
      { arrayFilters: arrayFilters as unknown as Record<string, unknown>[] },
    );
    repaired += result.modifiedCount ?? 0;
  }

  return { repaired };
}

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }
  await mongoose.connect(mongoUri);
  const result = await repairEmptyToolCallArguments(
    mongoose.connection.collection("sessions") as unknown as SessionsCollection,
  );
  console.log(`Repaired ${result.repaired} session(s) with empty tool-call arguments.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
}
