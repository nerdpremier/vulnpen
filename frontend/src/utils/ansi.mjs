// ANSI escape sequences necessarily contain a control character.
export const ANSI_REGEX =
  /\x1B\[[0-?]*[-[\]#-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-_]|\r(?!\n)/g;

/** Strip escape sequences the chat chokes on. Mirrors backend/src/utils/ansi.ts. */
export function stripAnsi(output) {
  return output.replace(ANSI_REGEX, "").trim();
}

/** Collapse blank/whitespace-only line runs. Mirrors backend/src/utils/ansi.ts. */
export function collapseBlankLines(text) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
