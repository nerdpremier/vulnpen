/**
 * Reduce an error to the fields that are safe to write to a log line.
 *
 * Why this exists: `body-parser` attaches the *raw request body* to a parse
 * failure — `createError(400, e, { body, type: "entity.parse.failed" })` — and
 * Node's `console.log(err)` prints every own property of an Error, not just the
 * stack. So `console.log(err)` on a rejected body wrote the whole thing out,
 * which for a login or register POST is the username and password in clear text
 * sitting in the container log.
 *
 * `message` is safe to keep: it is either JSON.parse's position report
 * ("Bad escaped character in JSON at position 9") or a fixed body-parser string,
 * never the payload. `type`, `code`, `status`/`statusCode` and `name` carry the
 * diagnostic value without the body.
 *
 * `includeStack` keeps `err.stack`. A stack is a plain string and never carries
 * the attached properties, so it is safe, and it is worth having where the error
 * may be a genuine bug. Leave it off for a per-request rejection such as a
 * malformed body, where the stack is noise a client can repeat at will.
 */
export interface LoggableError {
  name?: string;
  message?: string;
  type?: string;
  code?: string | number;
  status?: number;
  stack?: string;
}

export function scrubErrorForLog(err: unknown, includeStack = false): LoggableError {
  if (err === null || typeof err !== "object") {
    return { message: String(err) };
  }

  const source = err as Record<string, unknown>;
  const safe: LoggableError = {};

  if (typeof source.name === "string") safe.name = source.name;
  if (typeof source.message === "string") safe.message = source.message;
  if (typeof source.type === "string") safe.type = source.type;
  if (typeof source.code === "string" || typeof source.code === "number") {
    safe.code = source.code;
  }

  const status = typeof source.status === "number" ? source.status : source.statusCode;
  if (typeof status === "number") safe.status = status;

  if (includeStack && typeof source.stack === "string") safe.stack = source.stack;

  return safe;
}
