/**
 * PI (Personal Information) scrubber for FOIPPA compliance.
 *
 * Scrubs personal information from text before sending to cloud LLMs:
 *   - Display names → consistent anonymized labels (Person-1, Person-2, etc.)
 *   - Email addresses → [EMAIL]
 *   - Phone numbers → [PHONE]
 *   - IDIR usernames → [IDIR]
 *   - SIN (Social Insurance Numbers) → [SIN]
 *   - Session tokens and API keys → [TOKEN]
 *
 * Controlled by the RAVEN_SCRUB_PI environment variable:
 *   - "false" or "0": scrubbing disabled (pass-through for local-only LLMs)
 *   - anything else, including unset: scrubbing ENABLED (safe default)
 *
 * Set this in `~/.raven/.env` alongside your other credentials:
 *
 * ```env
 * RAVEN_SCRUB_PI=true
 * ```
 *
 * Each MCP server loads `~/.raven/.env` via dotenv at startup, so this
 * single setting controls scrubbing across all servers.
 *
 * @example
 * ```ts
 * const pi = new PiScrubber();
 * // With RAVEN_SCRUB_PI=true:
 * pi.scrub("Jane Smith");  // "Person-1"
 * pi.scrub("John Doe");    // "Person-2"
 * pi.scrub("Jane Smith");  // "Person-1" (consistent)
 * pi.scrubText("Contact jane@gov.bc.ca or call 250-555-1234");
 * // "Contact [EMAIL] or call [PHONE]"
 * ```
 */

const ENV_KEY = "RAVEN_SCRUB_PI";

/**
 * Luhn checksum, used to gate the unseparated nine-digit SIN pattern.
 *
 * A bare nine-digit run is ambiguous — it is just as likely an order number,
 * ticket id, or counter as a SIN. Redacting every one of them would make
 * application logs unreadable, which is its own failure. Canadian SINs carry a
 * Luhn check digit, so requiring the checksum keeps false positives to roughly
 * one in ten random nine-digit values while still catching real SINs written
 * in their most common machine-readable form.
 *
 * @param digits - Exactly the digit characters to verify.
 * @returns True when the value satisfies the Luhn checksum.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Patterns for regex-based PI scrubbing applied in scrubText().
 * Order matters — more specific patterns should come first.
 *
 * `replacement` accepts a function so a pattern can apply a secondary test
 * (see the unseparated SIN rule) rather than redacting every syntactic match.
 */
/**
 * Uppercase tokens of IDIR-like length that appear in attribution position in
 * ordinary logs and must not be redacted. Extend when a false positive is found.
 */
const IDIR_STOPLIST = new Set([
  "ERROR", "FATAL", "DEBUG", "TRACE", "HTTPS", "STDOUT", "STDERR", "STDIN",
  "ADMIN", "SYSTEM", "ORACLE", "TOMCAT", "APACHE", "NGINX", "LOCAL", "UNKNOWN",
  "DEFAULT", "TIMEOUT", "FAILED", "PASSED", "SUCCESS", "CLOSED", "OPENED",
  "ACTIVE", "PENDING", "ENABLED", "DISABLED", "MISSING", "INVALID", "EXPIRED",
  "DENIED", "ALLOWED", "SERVER", "CLIENT", "WEBADE", "BATCH", "DAEMON",
  "SERVICE", "PROXY", "BACKUP", "NOBODY", "ANONYMOUS", "SCHEDULER",
]);

/** A replacer: receives the match and any capture groups, returns the substitute. */
type Replacer = (match: string, ...groups: string[]) => string;

/**
 * Lift a literal replacement into replacer form so every rule has one shape.
 *
 * None of the literal substitutes use `$&`/`$1` backreferences, so returning
 * the string unchanged is exactly equivalent to `String#replace` with a
 * string argument. Having one shape removes the two-branch call in
 * scrubText that existed only to satisfy the `replace` overloads.
 */
const lit = (s: string): Replacer => () => s;

/**
 * Decode complete JSON string wrappers before interpreting credentials inside
 * them. In particular, JSON doubles an escaped apostrophe's backslashes without
 * changing its single-quote delimiters. Unchanged strings retain their original
 * bytes; changed strings use JSON's canonical escaping and retain their content.
 */
function scrubJsonStringContents(text: string): string {
  const parts: string[] = [];
  let previousEnd = 0;
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor++] !== '"') continue;
    const start = cursor - 1;
    while (cursor < text.length && text[cursor] !== '"' && !/[\r\n]/.test(text[cursor])) {
      cursor += text[cursor] === "\\" ? 2 : 1;
    }
    if (text[cursor] !== '"') continue;
    cursor += 1;
    const encoded = text.slice(start, cursor);
    if (!/(?:api[_-]?key|token|secret|password)/i.test(encoded)) continue;
    let decoded: string;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      // Ordinary log quotes need not form valid JSON string literals.
      continue;
    }
    const scrubbed = scrubCredentials(decoded);
    if (scrubbed !== decoded) {
      parts.push(text.slice(previousEnd, start), JSON.stringify(scrubbed));
      previousEnd = cursor;
    }
  }
  parts.push(text.slice(previousEnd));
  return parts.join("");
}

/**
 * Find scalar credentials from their key, then consume their complete value.
 * Starting at a literal key avoids retrying an unbounded quote/backslash prefix
 * at every input position. Each consumed value is skipped by the next search.
 */
function scrubCredentials(text: string): string {
  text = scrubJsonStringContents(text);
  const keys = /(?:api[_-]?key|token|secret|password)(\\*["'])?\s*[:=]/gi;
  const parts: string[] = [];
  let previousEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = keys.exec(text)) !== null) {
    const keyQuote = match[1];
    let start = match.index;
    if (keyQuote && text.slice(start - keyQuote.length, start) === keyQuote) {
      start -= keyQuote.length;
    }

    let valueStart = keys.lastIndex;
    // Raw log assignments stay on their line; formatted JSON may put the
    // value on the line after a quoted key.
    const whitespace = keyQuote ? /\s/ : /[ \t]/;
    while (valueStart < text.length && whitespace.test(text[valueStart])) valueStart += 1;
    let end = valueStart;
    while (text[end] === "\\") end += 1;
    const quote = text[end];
    if (quote === '"' || quote === "'") {
      const escaping = end - valueStart;
      end += 1;
      let backslashes = 0;
      while (end < text.length) {
        const char = text[end];
        // Physical newlines bound malformed log strings; JSON newlines are
        // escaped and stay inside the value.
        if (char === "\r" || char === "\n") break;
        end += 1;
        if (char === "\\") {
          backslashes += 1;
          continue;
        }
        // JSON encoding doubles existing backslashes and adds one before a
        // quote. Delimiters therefore have 0, 1, 3, 7, ... backslashes, while
        // escaped quotes inside a value have a different remainder. Also
        // allow pairs of encoded backslashes at the end of the value.
        if (char === quote && backslashes % (2 * (escaping + 1)) === escaping) break;
        backslashes = 0;
      }
    } else {
      end = valueStart;
      while (end < text.length && !/\s/.test(text[end])) {
        // Quoted keys identify structured scalar values such as null, false,
        // and numbers. Raw key=value passwords may themselves contain these
        // punctuation characters, so only whitespace terminates that form.
        if (keyQuote && /[,}\]]/.test(text[end])) break;
        end += 1;
      }
    }

    parts.push(text.slice(previousEnd, start), "[CREDENTIAL]");
    previousEnd = end;
    keys.lastIndex = end;
  }

  parts.push(text.slice(previousEnd));
  return parts.join("");
}

/** Preserve attribution heuristics and explicit identity labels through JSON wrappers. */
function scrubAttributedIdirs(text: string): string {
  const prefixes = /\b(?:(username|author|idir)|assigned to|reported by|created by|updated by|modified by|resolved by|closed by|requested by|submitted by|owner|reporter|assignee|reviewer|approver)(?:\\*["'])?[:\s]+(?:\\*["'])?/gi;
  const attributedToken = /[A-Z]{5,8}\b/y;
  // Explicit labels already accept 3-8 letters in either case in plain text.
  const labelledToken = /[A-Za-z]{3,8}\b/y;
  const parts: string[] = [];
  let previousEnd = 0;
  let prefix: RegExpExecArray | null;

  while ((prefix = prefixes.exec(text)) !== null) {
    const explicitLabel = Boolean(prefix[1]) && prefix[0].includes(":");
    const token = explicitLabel ? labelledToken : attributedToken;
    token.lastIndex = prefixes.lastIndex;
    const match = token.exec(text);
    // A rejected token can start another attribution ("owner assigned to
    // JSMITH"), so only advance past the token when it is actually redacted.
    if (!match || (!explicitLabel && IDIR_STOPLIST.has(match[0]))) continue;
    parts.push(text.slice(previousEnd, prefixes.lastIndex), "[IDIR]");
    previousEnd = token.lastIndex;
    prefixes.lastIndex = previousEnd;
  }

  parts.push(text.slice(previousEnd));
  return parts.join("");
}

const PI_PATTERNS: Array<{ pattern: RegExp; replacement: Replacer }> = [
  // SIN, separated: 123-456-789 or 123 456 789. No checksum gate here — a
  // three-three-three grouping is already a strong signal on its own.
  { pattern: /\b\d{3}[\s-]\d{3}[\s-]\d{3}\b/g, replacement: lit("[SIN]") },
  // SIN, unseparated: nine consecutive digits that pass the Luhn check.
  { pattern: /\b\d{9}\b/g, replacement: (m: string) => (passesLuhn(m) ? "[SIN]" : m) },
  // Email addresses
  { pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: lit("[EMAIL]") },
  // IDIR usernames (uppercase letters, typically 5-8 chars, appearing after common prefixes)
  { pattern: /(?:username|author|idir)[:=]\s*[A-Z]{3,8}\b/gi, replacement: lit("[IDIR]") },
  // IDIR format: USER@idir or USER@IDIR (also handles surrounding whitespace context)
  { pattern: /[A-Za-z0-9]+@[Ii][Dd][Ii][Rr]\b/g, replacement: lit("[IDIR]") },
  // IDIR domain-qualified form: IDIR\JSMITH. JSON wrappers double backslashes.
  { pattern: /\bIDIR\\+[A-Za-z0-9._-]+/gi, replacement: lit("[IDIR]") },
  // Phone numbers: North American formats
  // (250) 555-1234, 250-555-1234, 250.555.1234, +1-250-555-1234, 1-800-555-1234
  { pattern: /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, replacement: lit("[PHONE]") },
  // Phone numbers, unseparated NANP with optional 1 or +1 country code. Word
  // boundaries exclude substrings of longer numeric or alphanumeric IDs.
  // Both the area code and the exchange must start 2-9, excluding ten-digit
  // epoch timestamps and most numeric identifiers.
  { pattern: /(?<!\w)(?:\+?1)?[2-9]\d{2}[2-9]\d{6}\b/g, replacement: lit("[PHONE]") },
];
export class PiScrubber {
  /** Map from original displayName to anonymized label. */
  private nameMap: Map<string, string> = new Map();
  private nextId: number = 1;

  /**
   * Check if PI scrubbing is enabled via environment variable.
   */
  isEnabled(): boolean {
    const val = process.env[ENV_KEY];
    return val !== "false" && val !== "0";
  }

  /**
   * Scrub a display name. If scrubbing is disabled, returns the original.
   * If scrubbing is enabled, returns a consistent anonymized label.
   *
   * @param displayName - The person's display name (e.g., "Jane Smith")
   * @returns The original name (if disabled) or "Person-N" (if enabled)
   */
  scrub(displayName: string | null | undefined): string | null | undefined {
    if (displayName == null) return displayName;
    if (!this.isEnabled()) return displayName;

    const existing = this.nameMap.get(displayName);
    if (existing) return existing;

    const label = `Person-${this.nextId}`;
    this.nextId++;
    this.nameMap.set(displayName, label);
    return label;
  }

  /**
   * Scrub all personal information within a block of text.
   *
   * Applies two layers of scrubbing:
   *   1. Credential parsing and PI patterns — emails, phones, IDIRs, SINs, tokens
   *   2. Known names — names previously seen via scrub()
   *
   * @param text - The text to scrub
   * @returns The text with PI replaced by anonymized placeholders
   */
  scrubText(text: string): string {
    if (!this.isEnabled()) return text;

    // Scrub these token formats before a generic key consumes their label.
    let result = text
      .replace(/SMSESSION=[A-Za-z0-9+/=%\-_.]{10,}/g, "SMSESSION=[TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g, "Bearer [TOKEN]");
    result = scrubCredentials(result);

    // Layer 1: Regex-based pattern scrubbing
    for (const { pattern, replacement } of PI_PATTERNS) {
      // Reset lastIndex for global regexes reused across calls
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    }
    result = scrubAttributedIdirs(result);

    // Layer 2: Known name replacement
    if (this.nameMap.size > 0) {
      // Sort by length descending to avoid partial replacements
      // (e.g., "Jane Smith-Jones" before "Jane Smith")
      const entries = [...this.nameMap.entries()].sort(
        (a, b) => b[0].length - a[0].length
      );

      for (const [name, label] of entries) {
        result = result.replaceAll(name, label);
      }
    }

    return result;
  }

  /**
   * Reset the name mapping. Primarily for testing.
   */
  reset(): void {
    this.nameMap.clear();
    this.nextId = 1;
  }
}
