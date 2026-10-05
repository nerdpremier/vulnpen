// ANSI escape sequences necessarily contain a control character.
// eslint-disable-next-line no-control-regex
export const ANSI_REGEX =
  /\x1B\[[0-?]*[-[\]#-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-_]|\r(?!\n)/g;

/** Strip escape sequences the model and the chat both choke on. */
export function stripAnsi(output: string): string {
  return output.replace(ANSI_REGEX, "").trim();
}

/**
 * Progress bars and redraws leave runs of blank/whitespace-only lines that
 * render as stacked stray marks in the chat — collapse them to one.
 */
export function collapseBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
