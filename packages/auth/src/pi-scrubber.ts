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

const PI_PATTERNS: Array<{ pattern: RegExp; replacement: Replacer }> = [
  // SMSESSION tokens (long hex/base64 strings after SMSESSION=)
  { pattern: /SMSESSION=[A-Za-z0-9+/=%\-_.]{10,}/g, replacement: lit("SMSESSION=[TOKEN]") },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g, replacement: lit("Bearer [TOKEN]") },
  // Generic API keys / tokens. The minimum length is 8 rather than 16: an
  // eight-character password is weak, not absent, and leaking it is the same
  // disclosure as leaking a long one.
  // The value is matched to its delimiter, not to the end of an allowlisted
  // character run. Two earlier versions each stopped at a character outside
  // a class — first `!`, then `'`/`"` — and leaked the tail (or, when the
  // stray character came before the minimum length, failed to match at all
  // and leaked the whole value). The quoted branches find their own closing
  // quote -- counting an escape pair as one character, so a value containing
  // \" runs on to the real closing quote instead of ending at the escape and
  // leaving the rest of the secret in the clear; the unquoted branch stops at
  // whitespace and nothing else.
  //
  // The key side takes quotes too. JSON writes `"password": "..."`, so the
  // name is followed by its own closing quote — or by an escaped one when the
  // JSON is embedded in a log message as a string — before the separator ever
  // appears. Requiring the separator to follow the name directly meant no JSON
  // credential was ever redacted, which is the commonest shape in these logs.
  // The name's opening quote goes too, so the whole `"key": "value"` expression
  // is replaced the way `key=value` already was, rather than leaving a stray
  // quote behind.
  { pattern: /["'\\]*(?:api[_-]?key|token|secret|password)["'\\]*\s*[:=]\s*(?:"(?:[^"\\\r\n]|\\.){4,}"|'(?:[^'\\\r\n]|\\.){4,}'|[^\s]{6,})/gi, replacement: lit("[CREDENTIAL]") },
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
  // IDIR domain-qualified form: IDIR\JSMITH
  { pattern: /\bIDIR\\[A-Za-z0-9._-]+/gi, replacement: lit("[IDIR]") },
  // Bare IDIR in attribution context: "assigned to JSMITH", "reported by
  // JGAGAN", "owner: MSMITH". A blanket uppercase rule would redact
  // ERROR/WARN/HTTP and destroy log utility, so this requires all three of:
  // an attribution phrase, 5-8 uppercase letters (BC Gov IDIRs are initial +
  // surname), and a token not in the common-acronym stoplist.
  {
    pattern: /\b((?:assigned to|reported by|created by|updated by|modified by|resolved by|closed by|requested by|submitted by|owner|reporter|assignee|reviewer|approver|author)[:\s]+)([A-Z]{5,8})\b/g,
    replacement: (m: string, prefix: string, token: string) =>
      IDIR_STOPLIST.has(token) ? m : `${prefix}[IDIR]`,
  },
  // Phone numbers: North American formats
  // (250) 555-1234, 250-555-1234, 250.555.1234, +1-250-555-1234, 1-800-555-1234
  { pattern: /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, replacement: lit("[PHONE]") },
  // Phone numbers, unseparated ten-digit NANP. Both the area code and the
  // exchange must start 2-9, which excludes epoch-second timestamps (they
  // start with 1 for any plausible date) and most numeric identifiers.
  { pattern: /\b[2-9]\d{2}[2-9]\d{6}\b/g, replacement: lit("[PHONE]") },
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
   *   1. Regex patterns — emails, phones, IDIRs, SINs, tokens
   *   2. Known names — names previously seen via scrub()
   *
   * @param text - The text to scrub
   * @returns The text with PI replaced by anonymized placeholders
   */
  scrubText(text: string): string {
    if (!this.isEnabled()) return text;

    let result = text;

    // Layer 1: Regex-based pattern scrubbing
    for (const { pattern, replacement } of PI_PATTERNS) {
      // Reset lastIndex for global regexes reused across calls
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    }

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
