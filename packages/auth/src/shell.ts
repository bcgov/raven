/**
 * Shared shell-argument safety helpers.
 *
 * Both `@nrs/server-mcp` and `@nrs/imis-mcp` build remote shell commands and,
 * before this module existed, each carried its own private copy of
 * `shellEscape` plus its own metacharacter denylist. The copies drifted:
 * `imis-mcp` blocked the pipe character while `server-mcp` did not, and
 * neither blocked a newline or a single quote. That drift is what made
 * RSEC-001 and RSEC-002 two separate findings for what is really one defect.
 *
 * Keep the escaping and the control-character check here so the two packages
 * cannot diverge again.
 */

/**
 * Quote a single argument for POSIX `sh`.
 *
 * Wraps the value in single quotes and replaces each embedded single quote
 * with `'\''` — close the literal, emit an escaped quote, reopen the literal.
 * The result is always exactly one shell word, whatever the input contains.
 *
 * Prefer this over widening a denylist. A denylist has to enumerate every
 * dangerous character, and characters that are dangerous in one position are
 * legitimate in another: `|` is shell piping but also `grep -E` alternation,
 * so blocking it breaks real searches while escaping it does not.
 *
 * @param value - Raw argument value, from any source including user input.
 * @returns The value as a single safely quoted shell word.
 */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Characters that must never appear in a value destined for a shell command,
 * even when that value will be quoted.
 *
 * Quoting neutralizes metacharacters, so this deliberately does **not** repeat
 * the full metacharacter set. These inputs are rejected before command
 * construction or tokenization:
 *
 * - An unquoted `\n` can separate shell statements. CR/LF are also matched by
 *   `\s`, so whitespace-based tokenization can hide a line boundary from a
 *   validator. Inside single quotes they remain literal argument content;
 *   this API rejects them rather than accepting multiline inputs.
 * - `\0` truncates the argument at the C-string boundary.
 *
 * No legitimate log-search pattern, file path, or command argument in this
 * codebase contains one of these.
 */
export const SHELL_CONTROL_CHARS = /[\r\n\0]/;

/**
 * Report whether a value contains a shell control character.
 *
 * @param value - Candidate argument value.
 * @returns True when the value contains CR, LF, or NUL.
 */
export function hasShellControlChars(value: string): boolean {
  return SHELL_CONTROL_CHARS.test(value);
}

/**
 * Throw when a value contains a shell control character.
 *
 * Used at trust boundaries where rejecting is preferable to escaping, because
 * a control character in the input signals an injection attempt rather than an
 * unusual but legitimate value.
 *
 * @param value - Candidate argument value.
 * @param label - Field name used in the error message.
 * @throws Error when the value contains CR, LF, or NUL.
 */
export function assertNoShellControlChars(value: string, label: string): void {
  if (hasShellControlChars(value)) {
    throw new Error(`${label} contains a control character (newline, carriage return, or NUL)`);
  }
}

/** Require a portable absolute server base path without rewriting its value. */
export function assertSafeServerBasePath(value: string, label: string): void {
  if (!value.startsWith("/") || /[^A-Za-z0-9._/-]/.test(value)
    || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must be an absolute POSIX path using letters, digits, '.', '_', '-' and '/', without '.' or '..' segments`);
  }
}

/** Validate app/component path names, including leading underscores and hyphens. */
export function assertSafeServerIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} contains invalid characters (use letters, digits, '.', '_' or '-', without a leading dot)`);
  }
}
