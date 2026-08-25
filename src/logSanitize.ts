/**
 * Step output reaches the database and the SSE stream verbatim, and docker,
 * npm and pip all emit carriage returns and ANSI escapes while they work. Raw
 * C0 control characters inside a JSON string are not valid JSON, so one log
 * line carrying them can make a whole API response unparseable. Sanitising
 * happens where a line becomes a log record, so the stored row and the
 * streamed event always agree.
 */

// ESC [ ... final byte (CSI: colours, cursor moves, "erase line") and
// ESC ] ... BEL/ST (OSC: window titles).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// Everything below U+0020 except tab and newline, plus DEL.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strips terminal control sequences and normalises line endings. Nothing else
 * is removed and nothing is truncated.
 */
export function sanitizeLogMessage(message: string): string {
  return message
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI, '')
    .replace(CONTROL, '');
}
