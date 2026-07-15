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
 * Patterns for regex-based PI scrubbing applied in scrubText().
 * Order matters — more specific patterns should come first.
 */
const PI_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // SMSESSION tokens (long hex/base64 strings after SMSESSION=)
  { pattern: /SMSESSION=[A-Za-z0-9+/=%\-_.]{10,}/g, replacement: "SMSESSION=[TOKEN]" },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g, replacement: "Bearer [TOKEN]" },
  // Generic API keys / tokens (long hex strings, 32+ chars)
  { pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9\-_.~+/]{16,}["']?/gi, replacement: "[CREDENTIAL]" },
  // SIN: 9 digits with optional spaces or dashes (e.g., 123-456-789 or 123 456 789)
  { pattern: /\b\d{3}[\s-]\d{3}[\s-]\d{3}\b/g, replacement: "[SIN]" },
  // Email addresses
  { pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL]" },
  // IDIR usernames (uppercase letters, typically 5-8 chars, appearing after common prefixes)
  { pattern: /(?:username|author|idir)[:=]\s*[A-Z]{3,8}\b/gi, replacement: "[IDIR]" },
  // IDIR format: USER@idir or USER@IDIR (also handles surrounding whitespace context)
  { pattern: /[A-Za-z0-9]+@[Ii][Dd][Ii][Rr]\b/g, replacement: "[IDIR]" },
  // Phone numbers: North American formats
  // (250) 555-1234, 250-555-1234, 250.555.1234, +1-250-555-1234, 1-800-555-1234
  { pattern: /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, replacement: "[PHONE]" },
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
