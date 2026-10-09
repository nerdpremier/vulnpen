import assert from "node:assert/strict";
import test from "node:test";
import { repairEmptyToolCallArguments } from "../src/migrations/003-repair-empty-tool-call-arguments";

// ─── A stand-in for the sessions collection ──────────────────────────────
// It reproduces the three MongoDB rules this migration lives or dies by, all
// verified against a real server:
//
//   1. A filter path traverses arrays implicitly.
//   2. `{path: null}` — and `$in` containing null — also matches a path that is
//      simply absent. That is what made a loose filter select sessions with no
//      tool calls at all.
//   3. An update path may not skip an array level, and every `$[id]` segment
//      must resolve: `subagents.messages.$[message]` is rejected with "The path
//      'subagents.messages' must exist in the document in order to apply array
//      updates".
//
// Reproducing (2) and (3) is the point — without them the suite passes while
// the boot migration aborts on the first session that has a user message.

/** Values a dotted path reaches, traversing arrays; `undefined` when it does
 *  not resolve, which is what lets a null query match a missing path. */
function resolve(node: any, segments: string[]): any[] {
  if (segments.length === 0) return [node];
  if (Array.isArray(node)) return node.flatMap((el) => resolve(el, segments));
  if (node === null || typeof node !== "object") return [undefined];
  const [head, ...rest] = segments;
  const values = resolve(node[head], rest);
  return values.length ? values : [undefined];
}

function conditionMatches(value: any, condition: any): boolean {
  if (condition && typeof condition === "object" && "$elemMatch" in condition) {
    // $elemMatch requires a real array: a missing path never matches.
    if (!Array.isArray(value)) return false;
    return value.some((element) => queryMatches(element, condition.$elemMatch));
  }
  if (condition && typeof condition === "object" && "$in" in condition) {
    return (condition.$in as unknown[]).includes(value === undefined ? null : value);
  }
  throw new Error(`unsupported condition ${JSON.stringify(condition)}`);
}

function queryMatches(document: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([path, condition]) =>
    resolve(document, path.split(".")).some((value) => conditionMatches(value, condition)),
  );
}

/** Apply an update path the way MongoDB does: plain segments must resolve on
 *  objects (never on arrays), `$[id]` segments select the elements their
 *  arrayFilter admits. */
function applyUpdatePath(
  node: any,
  segments: string[],
  filters: Map<string, Record<string, any>>,
  value: string,
): number {
  const [segment, ...rest] = segments;
  const identifier = /^\$\[(.+)\]$/.exec(segment);

  if (identifier) {
    const name = identifier[1];
    const filter = filters.get(name);
    assert.ok(filter, `arrayFilter ${segment} must be declared`);
    assert.ok(Array.isArray(node), `update path ${segment} must address an array`);
    let modified = 0;
    for (const element of node) {
      if (!queryMatches(element, filter)) continue;
      modified += applyUpdatePath(element, rest, filters, value);
    }
    return modified;
  }

  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(
      `The path '${segment}' must exist in the document in order to apply array updates.`,
    );
  }
  if (rest.length === 0) {
    node[segment] = value;
    return 1;
  }
  return applyUpdatePath(node[segment], rest, filters, value);
}

function fakeSessions(docs: any[]) {
  return {
    docs,
    async updateMany(filter: any, update: any, options: any = {}) {
      const updatePath: string = Object.keys(update.$set)[0];
      const value: string = update.$set[updatePath];
      const filters = new Map<string, Record<string, any>>(
        (options.arrayFilters ?? []).map((f: Record<string, any>) => {
          const key = Object.keys(f)[0].split(".")[0];
          assert.ok(
            updatePath.includes(`$[${key}]`),
            `arrayFilter ${key} is not referenced by ${updatePath}`,
          );
          // The filter names its element, e.g. {"message.toolCalls": ...} is a
          // condition on the element bound to `message`.
          const [head, ...tail] = Object.keys(f)[0].split(".");
          assert.equal(head, key);
          return [key, { [tail.join(".")]: f[Object.keys(f)[0]] }];
        }),
      );

      let modifiedCount = 0;
      for (const doc of docs) {
        if (!queryMatches(doc, filter)) continue;
        modifiedCount += applyUpdatePath(doc, updatePath.split("."), filters, value);
      }
      return { modifiedCount };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("empty tool-call arguments are repaired in the transcript and in subagents", async () => {
  const sessions = fakeSessions([
    {
      sessionId: "victim",
      messages: [
        // A plain user message: no toolCalls at all. Selecting it with the
        // message arrayFilter would abort the update path.
        { role: "user", content: "scan" },
        {
          role: "assistant",
          toolCalls: [
            { id: "c1", name: "run_bash", arguments: "" },
            { id: "c2", name: "view_image", arguments: '{"path":"a.png"}' },
            { id: "c3", name: "get_state", arguments: null },
          ],
        },
        { role: "assistant", content: "done" },
      ],
    },
    {
      sessionId: "subagent-victim",
      subagents: [
        {
          subagentId: "s1",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              toolCalls: [
                { id: "c4", name: "n", arguments: "" },
                { id: "c5", name: "n", arguments: '{"keep":true}' },
              ],
            },
          ],
        },
      ],
    },
    {
      sessionId: "healthy",
      messages: [{ role: "assistant", toolCalls: [{ id: "c6", name: "n", arguments: "{}" }] }],
    },
  ]);

  const result = await repairEmptyToolCallArguments(sessions);

  assert.equal(result.repaired, 3);
  const [victim, subagentVictim, healthy] = sessions.docs;
  assert.deepEqual(
    victim.messages[1].toolCalls.map((c: any) => c.arguments),
    ["{}", '{"path":"a.png"}', "{}"],
  );
  // The nested transcript is reached through its own array identifier, and a
  // call that already carried arguments is untouched.
  assert.deepEqual(
    subagentVictim.subagents[0].messages[1].toolCalls.map((c: any) => c.arguments),
    ["{}", '{"keep":true}'],
  );
  assert.equal(healthy.messages[0].toolCalls[0].arguments, "{}");
});

test("sessions without a bad call are never selected, so the paths always resolve", async () => {
  // Every one of these matched the loose `{...: {$in: ["", null]}}` filter,
  // and the update then aborted the whole boot migration.
  const sessions = fakeSessions([
    { sessionId: "no-messages-field", turnIndex: 0 },
    { sessionId: "plain-messages", messages: [{ role: "user", content: "hi" }] },
    { sessionId: "no-subagents", messages: [{ role: "assistant", toolCalls: [{ id: "c", name: "n", arguments: "{}" }] }] },
    { sessionId: "subagents-without-messages", subagents: [{ subagentId: "s", status: "running" }] },
    { sessionId: "empty-messages", messages: [] },
  ]);

  const result = await repairEmptyToolCallArguments(sessions);
  assert.equal(result.repaired, 0);
});
