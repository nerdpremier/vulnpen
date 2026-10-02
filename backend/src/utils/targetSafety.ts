import { DangerCheckResult } from "./commandSafety";

/**
 * Deterministic detector for actions that delete, overwrite or disable data on
 * the engagement target.
 *
 * VulnPen runs proof-of-concept engagements: a finding is proven with the least
 * invasive evidence available, and the destructive step that would demonstrate
 * the full impact is deliberately not carried out against the client's live
 * data. commandSafety.ts guards the attack box; this module guards the target.
 *
 * A match never executes silently. It is surfaced to the operator as a
 * `destructive_target` consent request, and the Approve-for-me reviewer rejects
 * it unless the engagement itself carries explicit authorisation for
 * destructive testing.
 */

const SAFE_RESULT: DangerCheckResult = { dangerous: false, rule: "", reason: "", impact: "" };

function danger(rule: string, reason: string, impact: string): DangerCheckResult {
  return { dangerous: true, rule, reason, impact };
}

const IMPACT_DATA_LOSS =
  "ข้อมูล บัญชี หรือสิทธิ์บนเป้าหมายถูกลบหรือแก้ไขถาวร และอาจกู้คืนไม่ได้";
const IMPACT_OVERWRITE =
  "ข้อมูลเดิมบนเป้าหมายถูกเขียนทับ ผลลัพธ์จริงของระบบเปลี่ยนไปจากที่ผู้ใช้ตั้งใจไว้";
const IMPACT_REMOTE_CONTROL =
  "เครื่องเป้าหมายถูกสั่งการหรือเขียนไฟล์โดยตรง ผลกระทบไม่จำกัดอยู่ที่ข้อมูลทดสอบ";

/** HTTP DELETE issued by a command-line client or a Python HTTP library. */
const HTTP_DELETE_VERB_RE =
  /(?:^|[\s'"=])(?:-X|--request|--method)[=\s]*['"]?DELETE\b|(?:^|\s)http(?:ie)?\s+DELETE\b|\.delete\s*\(|["']method["']\s*[:=]\s*["']DELETE["']/i;

/** Any HTTP write verb, used together with the delete-endpoint rule. */
const HTTP_WRITE_VERB_RE =
  /(?:^|[\s'"=])(?:-X|--request|--method)[=\s]*['"]?(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)http(?:ie)?\s+(?:POST|PUT|PATCH|DELETE)\b|\.(?:post|put|patch|delete)\s*\(|["']method["']\s*[:=]\s*["'](?:POST|PUT|PATCH|DELETE)["']/i;

/** Verbs that replace an existing resource rather than create a new one. */
const HTTP_OVERWRITE_VERB_RE =
  /(?:^|[\s'"=])(?:-X|--request|--method)[=\s]*['"]?(?:PUT|PATCH)\b|(?:^|\s)http(?:ie)?\s+(?:PUT|PATCH)\b|\.(?:put|patch)\s*\(|["']method["']\s*[:=]\s*["'](?:PUT|PATCH)["']/i;

/** Endpoints whose whole purpose is to remove or disable a resource. */
const DELETE_ENDPOINT_RE =
  /[/?&=](?:_?delete|_?remove|destroy|deactivate|revoke|purge|trash)(?:[/?&=#'"\s]|$)/i;

/** A path segment that points at one existing object (numeric or UUID id). */
const RESOURCE_ID_RE = /\/\d+(?:[/?&#\s'"]|$)|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

/** Header or form field that turns a harmless verb into DELETE. */
const METHOD_OVERRIDE_DELETE_RE =
  /(?:x-http-method-override|x-method-override|_method)["']?\s*[:=]\s*["']?DELETE\b/i;

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
    DELETE_ENDPOINT_RE.test(target)
  ) {
    return danger(
      "http:raw-delete-endpoint",
      "คำขอ HTTP ที่จะส่งถึงเป้าหมายเรียกปลายทางที่ลบหรือปิดการใช้งานข้อมูล",
      IMPACT_DATA_LOSS,
    );
  }
  return undefined;
}

/**
 * True when the text would delete, overwrite or disable data on the target —
 * through a shell command, a Python script, a shell input or a raw HTTP request.
 */
export function detectDestructiveTargetAction(text: string): DangerCheckResult {
  if (!text || typeof text !== "string") return SAFE_RESULT;

  if (METHOD_OVERRIDE_DELETE_RE.test(text)) {
    return danger(
      "http:method-override-delete",
      "คำขอแปลงเมธอดเป็น DELETE ผ่าน method-override ไปยังเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  const rawLine = rawRequestLineDanger(text);
  if (rawLine) return rawLine;

  if (DESTRUCTIVE_SQL_RE.test(text)) {
    return danger(
      "sql:destructive",
      "มีคำสั่ง SQL ที่ลบหรือเขียนทับข้อมูลบนเป้าหมาย (DROP / TRUNCATE / DELETE FROM / UPDATE)",
      IMPACT_DATA_LOSS,
    );
  }

  if (TOOL_TARGET_WRITE_RE.test(text)) {
    return danger(
      "tool:target-write",
      "ใช้ความสามารถเปิดเชลล์หรือเขียนไฟล์บนเครื่องเป้าหมาย",
      IMPACT_REMOTE_CONTROL,
    );
  }

  if (HTTP_DELETE_VERB_RE.test(text)) {
    return danger(
      "http:delete-method",
      "ส่งคำขอ HTTP ด้วยเมธอด DELETE ไปยังเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  if (HTTP_WRITE_VERB_RE.test(text) && DELETE_ENDPOINT_RE.test(text)) {
    return danger(
      "http:delete-endpoint",
      "เรียกปลายทางที่ทำหน้าที่ลบหรือปิดการใช้งานข้อมูลบนเป้าหมาย",
      IMPACT_DATA_LOSS,
    );
  }

  if (HTTP_OVERWRITE_VERB_RE.test(text) && RESOURCE_ID_RE.test(text)) {
    return danger(
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