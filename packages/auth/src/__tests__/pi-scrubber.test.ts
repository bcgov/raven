import { describe, it, expect, beforeEach } from "vitest";
import { PiScrubber } from "../pi-scrubber.js";

/**
 * RSEC-004 regression suite.
 *
 * The original PI_PATTERNS made the separator mandatory inside the SIN and
 * phone patterns, despite the comment describing it as optional, and matched an
 * IDIR only after a labelling prefix. `scrubText` is the last control before
 * enterprise content reaches a model and before audit records are written, so a
 * SIN written as nine consecutive digits — the common machine-readable form —
 * left the workstation unredacted.
 */
describe("PiScrubber.scrubText — FOIPPA coverage (RSEC-004)", () => {
  let pi: PiScrubber;

  beforeEach(() => {
    delete process.env["RAVEN_SCRUB_PI"]; // undefined means enabled
    pi = new PiScrubber();
  });

  describe("social insurance numbers", () => {
    // 046 454 286 is a synthetic SIN that satisfies the Luhn checksum.
    it("redacts a dash-separated SIN", () => {
      expect(pi.scrubText("SIN 046-454-286")).toBe("SIN [SIN]");
    });

    it("redacts a space-separated SIN", () => {
      expect(pi.scrubText("SIN 046 454 286")).toBe("SIN [SIN]");
    });

    it("redacts an unseparated nine-digit SIN", () => {
      expect(pi.scrubText("SIN 046454286")).toBe("SIN [SIN]");
    });

    it("leaves a nine-digit number that fails the Luhn check alone", () => {
      // Deliberate trade-off: redacting every nine-digit token would destroy
      // log utility (order numbers, ticket ids, counters). The checksum gate
      // keeps false positives near 10% of random nine-digit values.
      expect(pi.scrubText("order 123456789")).toBe("order 123456789");
    });

    it("does not redact inside a longer digit run", () => {
      expect(pi.scrubText("id 12345678901234")).toBe("id 12345678901234");
    });
  });

  describe("phone numbers", () => {
    it("redacts a dash-separated phone number", () => {
      expect(pi.scrubText("call 250-555-1234")).toBe("call [PHONE]");
    });

    it("redacts an unseparated ten-digit phone number", () => {
      expect(pi.scrubText("call 2505551234")).toBe("call [PHONE]");
    });

    it("leaves a ten-digit epoch timestamp alone", () => {
      // NANP area and exchange codes both start 2-9, so epoch seconds
      // (which start with 1 for any plausible date) never match.
      expect(pi.scrubText("ts 1789418992")).toBe("ts 1789418992");
    });
  });

  describe("credentials", () => {
    it("redacts a long credential value", () => {
      expect(pi.scrubText("password=SuperSecret12345678")).toBe("[CREDENTIAL]");
    });

    it("redacts a short credential value", () => {
      expect(pi.scrubText("password=Secret12")).toBe("[CREDENTIAL]");
    });
  });

  describe("identifiers that already worked", () => {
    it("redacts email addresses", () => {
      expect(pi.scrubText("mail jane.smith@gov.bc.ca")).toBe("mail [EMAIL]");
    });

    it("redacts a prefixed IDIR", () => {
      expect(pi.scrubText("username: JSMITH")).toBe("[IDIR]");
    });

    it("redacts a domain-qualified IDIR", () => {
      expect(pi.scrubText("user IDIR\\JSMITH logged in")).toBe("user [IDIR] logged in");
    });

    it("redacts bearer tokens", () => {
      expect(pi.scrubText("Authorization: Bearer abc123def456")).toBe("Authorization: Bearer [TOKEN]");
    });
  });

  describe("log utility is preserved", () => {
    it("leaves ordinary log levels and identifiers intact", () => {
      const line = "ERROR [main] RRS-API startup failed after 3 retries (HTTP 503)";
      expect(pi.scrubText(line)).toBe(line);
    });
  });

  describe("scrubbing disabled", () => {
    it("returns text unchanged when RAVEN_SCRUB_PI=false", () => {
      process.env["RAVEN_SCRUB_PI"] = "false";
      const disabled = new PiScrubber();
      expect(disabled.scrubText("SIN 046454286")).toBe("SIN 046454286");
    });
  });
});

describe("PiScrubber.scrubText — credential values are redacted whole", () => {
  let pi: PiScrubber;
  beforeEach(() => { delete process.env["RAVEN_SCRUB_PI"]; pi = new PiScrubber(); });

  it("redacts a value containing punctuation outside the old character class", () => {
    // The class-based pattern stopped at the first unlisted character and
    // emitted "[CREDENTIAL]!suffix", leaking the tail of the secret.
    expect(pi.scrubText("password=Secret12!suffix")).toBe("[CREDENTIAL]");
  });

  it("redacts a value containing a dollar sign", () => {
    expect(pi.scrubText("api_key: abc12345$extra")).toBe("[CREDENTIAL]");
  });

  it("redacts a double-quoted value whole", () => {
    expect(pi.scrubText('password="p@ss w0rd!"')).toBe("[CREDENTIAL]");
  });

  it("redacts a single-quoted value whole", () => {
    expect(pi.scrubText("secret='a!b@c#d$'")).toBe("[CREDENTIAL]");
  });

  it("stops at whitespace and does not swallow the rest of the line", () => {
    expect(pi.scrubText("password=Secret12! and then some prose")).toBe("[CREDENTIAL] and then some prose");
  });
});

describe("PiScrubber.scrubText — credentials containing quotes (review Issue 3)", () => {
  let pi: PiScrubber;
  beforeEach(() => { delete process.env["RAVEN_SCRUB_PI"]; pi = new PiScrubber(); });

  it("redacts a value whole when a quote appears before the minimum length", () => {
    // The unquoted branch excluded quotes, so this failed to match at all and
    // the entire credential passed through unredacted.
    expect(pi.scrubText("password=Sec'ret1andmore")).toBe("[CREDENTIAL]");
    expect(pi.scrubText('password=Sec"ret1andmore')).toBe("[CREDENTIAL]");
    expect(pi.scrubText("api_key: abc'defghij")).toBe("[CREDENTIAL]");
  });

  it("redacts the tail when a quote appears after the minimum length", () => {
    expect(pi.scrubText("password=Secret12'suffix")).toBe("[CREDENTIAL]");
    expect(pi.scrubText('password=Secret12"suffix')).toBe("[CREDENTIAL]");
  });

  it("still stops at whitespace", () => {
    expect(pi.scrubText("password=Sec'ret12 then prose")).toBe("[CREDENTIAL] then prose");
  });
});

describe("PiScrubber.scrubText — bare IDIR in attribution context (review Issue 6)", () => {
  let pi: PiScrubber;
  beforeEach(() => { delete process.env["RAVEN_SCRUB_PI"]; pi = new PiScrubber(); });

  it("redacts the documented leak: an IDIR after an attribution word", () => {
    expect(pi.scrubText("assigned to JSMITH today")).toBe("assigned to [IDIR] today");
    expect(pi.scrubText("reported by JGAGAN")).toBe("reported by [IDIR]");
    expect(pi.scrubText("owner: MSMITH")).toBe("owner: [IDIR]");
    expect(pi.scrubText("reviewer TWILSON approved")).toBe("reviewer [IDIR] approved");
  });

  it("does not redact common acronyms in the same position", () => {
    // These are the false positives a blanket uppercase rule would produce.
    expect(pi.scrubText("for HTTP requests")).toBe("for HTTP requests");
    expect(pi.scrubText("assigned to ERROR")).toBe("assigned to ERROR");
    expect(pi.scrubText("sent to JSON")).toBe("sent to JSON");
    expect(pi.scrubText("reported by HTTPS client")).toBe("reported by HTTPS client");
    expect(pi.scrubText("owner: NULL")).toBe("owner: NULL");
  });

  it("does not redact uppercase tokens with no attribution context", () => {
    expect(pi.scrubText("ERROR JSMITH FATAL")).toBe("ERROR JSMITH FATAL");
  });
});

// ---------------------------------------------------------------------------
// Self-review follow-up: both this rule and the one it replaced on main require
// the key name to be followed immediately by the separator, so a JSON-quoted
// key ("password": "…") never matched and the value passed through in full.
// Structured JSON is the common shape in these logs, which makes it the most
// likely credential form to reach a model or an audit record unredacted.
// ---------------------------------------------------------------------------

describe("PiScrubber.scrubText — credentials with a quoted key name", () => {
  let pi: PiScrubber;
  beforeEach(() => { delete process.env["RAVEN_SCRUB_PI"]; pi = new PiScrubber(); });

  it("redacts a JSON credential, spaced or compact", () => {
    expect(pi.scrubText('{"password": "s3cr3tval"}')).toBe('{[CREDENTIAL]}');
    expect(pi.scrubText('{"password" : "s3cr3tval"}')).toBe('{[CREDENTIAL]}');
  });

  it("redacts only the credential and leaves sibling fields readable", () => {
    expect(pi.scrubText('{"password":"s3cr3tval","user":"bob"}'))
      .toBe('{[CREDENTIAL],"user":"bob"}');
  });

  it("handles single-quoted and escaped key forms", () => {
    expect(pi.scrubText("{'api_key': 'abc123def'}")).toBe("{[CREDENTIAL]}");
    expect(pi.scrubText('msg={\\"token\\":\\"abc123def\\"}')).toContain("[CREDENTIAL]");
  });

  it("still redacts the unquoted key forms", () => {
    expect(pi.scrubText("password=hunter22")).toBe("[CREDENTIAL]");
    expect(pi.scrubText("api_key: abc12345$extra")).toBe("[CREDENTIAL]");
  });
});
