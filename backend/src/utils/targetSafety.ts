/** Result of a deterministic destructive-action scan. */
export interface DangerCheckResult {
  dangerous: boolean;
  /** Stable rule id, for tests and consent statistics. */
  rule: string;
  /** Short Thai reason shown in the consent dialog. */
  reason: string;
  /** Short Thai impact statement shown in the consent dialog. */
  impact: string;
  /**
   * True when the hit is a *replacement* rather than a removal (`PUT`/`PATCH`
   * onto an existing resource, `UPDATE … SET`). A replacement is gated because
   * it destroys the original value, but it is not the one action the product
   * refuses to let a person authorise, so the consent dialog names it
   * differently and it is treated as a boundary rather than a deletion.
   */
  overwrite?: boolean;
}

/**
 * Deterministic detector for actions that delete, overwrite or disable data on
 * the engagement target.
 *
 * VulnPen runs proof-of-concept engagements: a finding is proven with the least
 * invasive evidence available, and the destructive step that would demonstrate
 * the full impact is deliberately not carried out against the client's live
 * data. This module guards the target; there is no attack-box rule set — the
 * attack box is the tester's disposable infrastructure.
 *
 * A match never executes silently. It is surfaced to the operator as a
 * `destructive_target` verdict, which stops the call for approval in every
 * mode — including `auto`, where the agent otherwise works unsupervised.
 *
 * This is a text rule over the command the agent wrote, so it is a *judgement
 * about meaning* and inherits the limits of one: a payload that merely contains
 * the word `delete`, or prose quoting a statement, reads the same as the real
 * thing, and an inventively named endpoint reads as nothing at all. That is why
 * it asks rather than refuses: the operator sees the command and the reason and
 * decides.
 */

const SAFE_RESULT: DangerCheckResult = { dangerous: false, rule: "", reason: "", impact: "" };

function danger(rule: string, reason: string, impact: string): DangerCheckResult {
  return { dangerous: true, rule, reason, impact };
}

/** A replacement of existing data rather than a removal of it. */
function overwrite(rule: string, reason: string, impact: string): DangerCheckResult {
  return { dangerous: true, rule, reason, impact, overwrite: true };
}

const IMPACT_DATA_LOSS =
  "ข้อมูล บัญชี หรือสิทธิ์บนเป้าหมายถูกลบหรือแก้ไขถาวร และอาจกู้คืนไม่ได้";
const IMPACT_OVERWRITE =
  "ข้อมูลเดิมบนเป้าหมายถูกเขียนทับ ผลลัพธ์จริงของระบบเปลี่ยนไปจากที่ผู้ใช้ตั้งใจไว้";
const IMPACT_REMOTE_CONTROL =
  "เครื่องเป้าหมายถูกสั่งการหรือเขียนไฟล์โดยตรง ผลกระทบไม่จำกัดอยู่ที่ข้อมูลทดสอบ";

/** HTTP DELETE issued by a command-line client or a Python HTTP library. */
const HTTP_DELETE_VERB_RE =
  /(?:^|[\s'"=])(?:-X|--request|--method)[=\s]*['"]?DELETE\b|(?:^|[\s'"])http(?:ie)?\s+DELETE\b|\.delete\s*\(|\.request\s*\(\s*["']DELETE\b|["']?method["']?\s*[:=]\s*["']?DELETE\b/i;

/** Any HTTP write verb, used together with the delete-endpoint rule. */
const HTTP_WRITE_VERB_RE =
  /(?:^|[\s'"=])(?:-X|--request|--method)[=\s]*['"]?(?:POST|PUT|PATCH|DELETE)\b|(?:^|[\s'"])http(?:ie)?\s+(?:POST|PUT|PATCH|DELETE)\b|\.(?:post|put|patch|delete)\s*\(|\.request\s*\(\s*["'](?:POST|PUT|PATCH|DELETE)\b|["']?method["']?\s*[:=]\s*["']?(?:POST|PUT|PATCH|DELETE)\b/i;

/** Verbs that replace an existing resource rather than create a new one. */
const HTTP_OVERWRITE_VERB_RE =
  /(?:^|[\s'"=])(?:-X|--request|--method)[=\s]*['"]?(?:PUT|PATCH)\b|(?:^|[\s'"])http(?:ie)?\s+(?:PUT|PATCH)\b|\.(?:put|patch)\s*\(|\.request\s*\(\s*["'](?:PUT|PATCH)\b|["']?method["']?\s*[:=]\s*["']?(?:PUT|PATCH)\b/i;

/** Words that make a path segment or query parameter a removal operation. */
const DELETE_WORDS = new Set([
  "delete",
  "remove",
  "destroy",
  "deactivate",
  "disable",
  "revoke",
  "purge",
  "trash",
  "wipe",
  "erase",
]);

const URL_SEGMENT_RE = /([/?&=;])([^/?&=;#\s'"]+)/g;

/**
 * Query keys that hold an *operation* rather than data, so the value beside
 * them is judged like a path segment (`?action=remove`). Every other value is
 * what the caller searched for, filtered by or echoed — `?q=delete` is a search
 * for a word, not a request that removes anything — and is deliberately left
 * alone. Only the method (a token) and the path (a name) carry the 100%
 * guarantees; value judgement is the best-effort half of this rule.
 */
const OPERATION_KEY_WORDS = new Set([
  "action",
  "op",
  "operation",
  "cmd",
  "command",
  "method",
  "do",
  "func",
  "task",
]);

/**
 * The target a request names — the URL, and nothing else. Used by the endpoint
 * rules, which must not be tripped by a payload carried alongside: a POST body
 * containing `q=delete` is a probe of a search endpoint, not a call to one that
 * removes data. Verb rules (`-X PUT`, `.delete(`) still read the whole command,
 * because there the verb *is* the operation the agent asked for.
 */
function endpointTarget(text: string): string {
  const tokens: string[] = text.match(/https?:\/\/\S+/gi) ?? [];
  // A path-shaped token (`/api/Users/1/delete`, `/rest/user/remove`) covers the
  // shapes that carry no absolute URL: a raw request line, a Python call, a
  // bare curl path. A body parameter (`q=delete`, `action=remove`) has no
  // leading slash and is not an endpoint, so it is not read.
  for (const match of text.matchAll(/(?:^|[\s'"=,([])(\/[^\s'"\],)]*)/g)) {
    tokens.push(match[1]);
  }
  return tokens.join(" ");
}

/**
 * True when the request *names* a removal operation: a path segment
 * (`/delete`, `/deleteUser`, `/delete_user`, `/user-delete`) or a query key,
 * plus the value of an operation key (`?action=remove`).
 *
 * Segments are split into words on punctuation and on camelCase boundaries, so
 * `deleted` and `removed` (fields and states, not operations) are not matched.
 *
 * A query *value* under an ordinary key is not judged — it is data the caller
 * chose, not the name of the thing being called. `?q=delete` is a search for a
 * word; refusing it cost the agent every read of a page, filter or product
 * whose parameter merely spelled one. See OPERATION_KEY_WORDS.
 */
export function hasDeleteEndpoint(text: string): boolean {
  let lastKey: string | null = null;
  for (const match of text.matchAll(URL_SEGMENT_RE)) {
    const separator = match[1];
    const token = match[2];
    if (separator === "=") {
      // Value slot: only an operation key puts an operation here.
      const isOperationValue =
        lastKey !== null &&
        OPERATION_KEY_WORDS.has(lastKey) &&
        namesRemoval(token);
      lastKey = null;
      if (isOperationValue) return true;
      continue;
    }
    if (namesRemoval(token)) return true;
    lastKey = separator === "/" ? null : token.toLowerCase();
  }
  return false;
}

/** One path segment, query key or query value, split into words and checked. */
function namesRemoval(token: string): boolean {
  const words = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((word) => DELETE_WORDS.has(word));
}

/** A GraphQL mutation whose field removes or disables something. */
const GRAPHQL_DESTRUCTIVE_RE =
  /\bmutation\b[^{]*\{[^}]*?\b(?:delete|remove|destroy|drop|purge|wipe|erase|deactivate|disable|revoke|terminate)[A-Za-z0-9_]*\s*[({:]/i;

/** A path segment that points at one existing object (numeric or UUID id). */
const RESOURCE_ID_RE = /\/\d+(?:[/?&#\s'"]|$)|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

/** Header or form field that turns a harmless verb into DELETE. */
const METHOD_OVERRIDE_DELETE_RE =
  /(?:x-http-method-override|x-http-method|x-method-override|_method)["']?\s*[:=]\s*["']?DELETE\b/i;

/** SQL that removes or rewrites existing data instead of reading it. */
const DESTRUCTIVE_SQL_RE =
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|USER|ROLE|COLUMN)\b|TRUNCATE\s+(?:TABLE\s+)?(?!the\b|a\b|an\b)[A-Za-z_`"][\w.$`"]*|DELETE\s+FROM\s+(?!the\b|a\b|an\b)[A-Za-z_`"][\w.$`"]*|ALTER\s+TABLE\s+\S+\s+DROP\b|UPDATE\s+[A-Za-z_`"][\w.$`"]*\s+SET\s+[^;=]{1,60}=)/i;

/** Tooling flags that hand the tester a shell or a write primitive on the target. */
const TOOL_TARGET_WRITE_RE =
  /(?:^|\s)--(?:os-shell|os-cmd|os-pwn|sql-shell|file-write|file-dest)(?:\s|=|$)/i;

/** A browser goal that asks for something to be deleted or switched off. */
const DESTRUCTIVE_GOAL_RE =
  /\b(?:delete|deleting|remove|removing|destroy|destroying|wipe|erase|erasing|purge|purging|deactivate|deactivating|disable|disabling|revoke|revoking|unlink|unlinking|terminate|terminating|shutdown|shut\s+down|reset\s+the\s+password|drop\s+the\s+(?:database|table))\b/i;

/**
 * A goal that explicitly rules the destructive step out ("check whether the
 * Delete control is reachable without deleting anything") is the safe phrasing
 * the rules of engagement ask for, so it must not be gated as destructive. The
 * negation has to precede the verb: "delete the admin, do not ask" is not an
 * opt-out.
 */
const GOAL_OPTS_OUT_RE =
  /\b(?:do\s+not|don't|never|without|avoid|refrain\s+from)\b[^.;\n]{0,60}?\b(?:delete|deleting|remove|removing|destroy|destroying|wipe|erase|purge|deactivate|disable|revoke|unlink|terminate|shutdown|reset)\b/i;

/**
 * A raw HTTP request line is what a Burp Repeater/Intruder call carries, so it
 * needs its own check: there is no `curl -X` in sight.
 */
function rawRequestLineDanger(text: string): DangerCheckResult | undefined {
  // CRLF is allowed before the end of the line: a raw request handed to Burp
  // carries \r\n line endings.
  const match = text.match(/^[ \t]*([A-Za-z]{3,7})[ \t]+(\S+)[ \t]+HTTP\/\d(?:\.\d)?[ \t\r]*$/m);
  if (!match) return undefined;
  const method = match[1].toUpperCase();
  const target = match[2];
  if (method === "DELETE") {
    return danger(
      "http:raw-delete",
      "คำขอ HTTP ที่จะส่งถึงเป้าหมายเป็นเมธอด DELETE",
      IMPACT_DATA_LOSS,
    );
  }
  if (
    (method === "POST" || method === "PUT" || method === "PATCH") &&
    hasDeleteEndpoint(target)
  ) {
    return danger(
      "http:raw-delete-endpoint",
      "คำขอ HTTP ที่จะส่งถึงเป้าหมายเรียกปลายทางที่ลบหรือปิดการใช้งานข้อมูล",
      IMPACT_DATA_LOSS,
    );
  }
  // A raw request carries no `-X PUT` for the verb rules to read, so the
  // overwrite case has to be recognised from the request line itself.
  if ((method === "PUT" || method === "PATCH") && RESOURCE_ID_RE.test(target)) {
    return overwrite(
      "http:raw-overwrite",
      "คำขอ HTTP ที่จะส่งถึงเป้าหมายเขียนทับรายการที่มีอยู่แล้ว",
      IMPACT_OVERWRITE,
    );
  }
  return undefined;
}

/**
 * Undo the two shapes that hide a verb from a text rule, without changing what
 * the action is:
 *   - a command argument list (`["curl","-X","DELETE",url]`) is one command
 *     spread across several literals, so the quotes around the separators go;
 *   - SQL block comments are removed with no replacement, so `DEL/**\/ETE FROM`
 *     reads as `DELETE FROM` instead of slipping past the statement rule.
 */
function normalizedForMatching(text: string): string {
  return text
    .replace(/"\s*,\s*"/g, " ")
    .replace(/'\s*,\s*'/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * True when the text would delete, overwrite or disable data on the target —
 * through a shell command, a Python script, a shell input or a raw HTTP request.
 */
export function detectDestructiveTargetAction(text: string): DangerCheckResult {
  if (!text || typeof text !== "string") return SAFE_RESULT;
  const probe = normalizedForMatching(text);

  if (METHOD_OVERRIDE_DELETE_RE.test(probe)) {
    return danger(
      "http:method-override-delete",
      "คำขอแปลงเมธอดเป็น DELETE ผ่าน method-override ไปยังเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  const rawLine = rawRequestLineDanger(probe);
  if (rawLine) return rawLine;

  if (DESTRUCTIVE_SQL_RE.test(probe)) {
    return danger(
      "sql:destructive",
      "มีคำสั่ง SQL ที่ลบหรือเขียนทับข้อมูลบนเป้าหมาย (DROP / TRUNCATE / DELETE FROM / UPDATE)",
      IMPACT_DATA_LOSS,
    );
  }

  if (TOOL_TARGET_WRITE_RE.test(probe)) {
    return danger(
      "tool:target-write",
      "ใช้ความสามารถเปิดเชลล์หรือเขียนไฟล์บนเครื่องเป้าหมาย",
      IMPACT_REMOTE_CONTROL,
    );
  }

  if (HTTP_DELETE_VERB_RE.test(probe)) {
    return danger(
      "http:delete-method",
      "ส่งคำขอ HTTP ด้วยเมธอด DELETE ไปยังเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  if (GRAPHQL_DESTRUCTIVE_RE.test(probe)) {
    return danger(
      "graphql:destructive-mutation",
      "GraphQL mutation ที่ลบหรือปิดการใช้งานข้อมูลบนเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  // The endpoint rules read the *target* the request names, never the body.
  // A payload is not an instruction: `-d 'q=delete'` and a POST body carrying
  // the word are evidence the operator is collecting, and reading the whole
  // probe flagged every one of them as an endpoint that removes data.
  if (HTTP_WRITE_VERB_RE.test(probe) && hasDeleteEndpoint(endpointTarget(probe))) {
    return danger(
      "http:delete-endpoint",
      "เรียกปลายทางที่ทำหน้าที่ลบหรือปิดการใช้งานข้อมูลบนเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  if (HTTP_OVERWRITE_VERB_RE.test(probe) && RESOURCE_ID_RE.test(probe)) {
    return overwrite(
      "http:overwrite",
      "เขียนทับข้อมูลเดิมบนเป้าหมายด้วย PUT/PATCH ไปยังรายการที่มีอยู่แล้ว",
      IMPACT_OVERWRITE,
    );
  }

  return SAFE_RESULT;
}

/**
 * Boundary for a browser goal. The browser agent acts on the real application,
 * so a goal that names a destructive outcome is a destructive target action even
 * though no shell command is involved.
 */
export function detectDestructiveBrowserGoal(goal: string): DangerCheckResult {
  if (!goal || typeof goal !== "string") return SAFE_RESULT;
  if (GOAL_OPTS_OUT_RE.test(goal)) return SAFE_RESULT;
  if (!DESTRUCTIVE_GOAL_RE.test(goal)) return SAFE_RESULT;
  return danger(
    "browser:destructive-goal",
    "เป้าหมายของ browser_action สั่งให้ลบ เขียนทับ หรือปิดใช้งานข้อมูล/บัญชีบนเป้าหมาย",
    "บราวเซอร์จะลงมือกับข้อมูลจริงบนเป้าหมาย และย้อนกลับได้ยาก",
  );
}