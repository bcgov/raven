/**
 * Pure line-range/char-cap slicing for the read_file tool.
 */

export interface SliceOptions {
  /** First line to return (1-based, inclusive). Defaults to 1. */
  startLine?: number;
  /** Last line to return (1-based, inclusive). Defaults to the last line. */
  endLine?: number;
  /** Character cap applied to the selected range. */
  maxChars: number;
}

export interface SliceSuccess {
  ok: true;
  /** The selected (possibly truncated) content. */
  text: string;
  /** 1-based first line included in text. */
  firstLine: number;
  /** 1-based last line included in text (may be partial). */
  lastLine: number;
  totalLines: number;
  totalChars: number;
  /** True when the char cap cut the requested range short. */
  truncated: boolean;
  /** True when lastLine was cut mid-line by the char cap. */
  partialLastLine: boolean;
  /** Line to resume from when more content remains; undefined when done. */
  nextStartLine?: number;
}

export interface SliceFailure {
  ok: false;
  reason: "invalid-range" | "past-eof";
  message: string;
}

export type SliceResult = SliceSuccess | SliceFailure;

export function sliceFileContent(
  content: string,
  opts: SliceOptions
): SliceResult {
  const { startLine, endLine, maxChars } = opts;

  if (
    (startLine !== undefined && !Number.isInteger(startLine)) ||
    (endLine !== undefined && !Number.isInteger(endLine))
  ) {
    return {
      ok: false,
      reason: "invalid-range",
      message: `startLine and endLine must be integers (got startLine=${startLine}, endLine=${endLine}).`,
    };
  }

  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    return {
      ok: false,
      reason: "invalid-range",
      message: `Invalid range: startLine=${startLine} > endLine=${endLine}.`,
    };
  }

  // Split into logical lines; a trailing newline does not create an extra line.
  let lines: string[];
  if (content === "") {
    lines = [];
  } else {
    lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }
  const totalLines = lines.length;
  const first = startLine ?? 1;

  if (totalLines === 0) {
    if (first > 1) {
      return {
        ok: false,
        reason: "past-eof",
        message: `No content starting at line ${first}. The file has only 0 lines.`,
      };
    }
    return {
      ok: true,
      text: "",
      firstLine: 1,
      lastLine: 0,
      totalLines: 0,
      totalChars: content.length,
      truncated: false,
      partialLastLine: false,
    };
  }

  if (first > totalLines) {
    return {
      ok: false,
      reason: "past-eof",
      message: `No content starting at line ${first}. The file has only ${totalLines} lines.`,
    };
  }

  const last = Math.min(endLine ?? totalLines, totalLines);
  const window = lines.slice(first - 1, last);

  // Emit whole lines until the next one would push past the cap.
  let emitted = 0;
  let length = 0;
  for (const line of window) {
    const add = emitted === 0 ? line.length : line.length + 1; // +1 for "\n"
    if (length + add > maxChars) {
      break;
    }
    length += add;
    emitted++;
  }

  if (emitted === 0) {
    // The first line alone exceeds the cap — emit a hard partial slice; the
    // caller must re-call with a larger maxChars to see the rest of it.
    return {
      ok: true,
      text: (window[0] ?? "").slice(0, maxChars),
      firstLine: first,
      lastLine: first,
      totalLines,
      totalChars: content.length,
      truncated: true,
      partialLastLine: true,
      nextStartLine: first,
    };
  }

  const truncated = emitted < window.length;
  const lastEmitted = first + emitted - 1;
  const nextStartLine = truncated
    ? lastEmitted + 1
    : last < totalLines
      ? last + 1
      : undefined;

  return {
    ok: true,
    text: window.slice(0, emitted).join("\n"),
    firstLine: first,
    lastLine: lastEmitted,
    totalLines,
    totalChars: content.length,
    truncated,
    partialLastLine: false,
    nextStartLine,
  };
}
