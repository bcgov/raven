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

    it.each(["2505551234", "12505551234", "+12505551234"])("redacts an unseparated phone with an optional country code: %s", (phone) => {
      for (const suffix of ["", ".", ", next", "; next", ")", " / next", " - next"]) {
        expect(pi.scrubText(`call ${phone}${suffix}`)).toBe(`call [PHONE]${suffix}`);
      }
    });

    it.each([
      "112505551234", "912505551234", "125055512340", "25055512345",
      "02505551234", "+112505551234", "+125055512345",
      "record12505551234", "12505551234suffix", "id_12505551234",
    ])("does not redact a phone substring inside a longer identifier: %s", (id) => {
      expect(pi.scrubText(`id ${id}`)).toBe(`id ${id}`);
    });

    it.each(["11205551234", "+11205551234", "12501551234", "+12501551234"])("retains NANP area and exchange constraints with a country code: %s", (number) => {
      expect(pi.scrubText(`value ${number}`)).toBe(`value ${number}`);
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

    it.each([String.raw`IDIR\JSMITH`, String.raw`idir\j.smith_2`])("redacts a domain-qualified IDIR through JSON wrappers: %s", (username) => {
      let input = username;
      let expected = "[IDIR]";
      for (let depth = 0; depth < 5; depth += 1) {
        expect(pi.scrubText(input)).toBe(expected);
        input = JSON.stringify({ user: input, level: "ERROR", message: "Database unavailable" });
        expected = JSON.stringify({ user: expected, level: "ERROR", message: "Database unavailable" });
      }
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

  it.each(["assignee", "owner", "Author", "reviewer"])("redacts quoted attribution field %s without breaking JSON", key => {
    let input = `{\"${key}\": \"JSMITH\"}`;
    let expected = `{\"${key}\": \"[IDIR]\"}`;
    for (let depth = 0; depth < 3; depth++) {
      expect(pi.scrubText(input)).toBe(expected);
      input = JSON.stringify(input);
      expected = JSON.stringify(expected);
    }
  });

  it.each(["jsmith", "JSmith", "ERROR", "SYSTEM", "JSMITHSON"])("preserves non-IDIR structured attribution %s", value => {
    const input = JSON.stringify({ owner: value });
    expect(pi.scrubText(input)).toBe(input);
  });

  it.each([
    "Assigned to", "ASSIGNED TO", "aSsIgNeD tO", "Reported By", "Created By",
    "Updated By", "Modified By", "Resolved By", "Closed By", "Requested By",
    "Submitted By", "OWNER:", "Reporter", "Assignee", "Reviewer", "Approver", "Author",
  ])("matches an attribution phrase regardless of case: %s", (prefix) => {
    expect(pi.scrubText(`${prefix} JSMITH, next`)).toBe(`${prefix} [IDIR], next`);
  });

  it.each(["jsmith", "JSmith", "JSMIth", "JOHN", "JSMITHSON", "JSMITH2", "JSMITH_suffix"])("preserves tokens outside the uppercase IDIR heuristic: %s", (token) => {
    expect(pi.scrubText(`Assigned to ${token}`)).toBe(`Assigned to ${token}`);
    expect(pi.scrubText(`OWNER: ${token}`)).toBe(`OWNER: ${token}`);
  });

  it.each(["ERROR", "HTTPS", "SYSTEM", "ADMIN", "SCHEDULER", "ANONYMOUS"])("preserves stoplisted tokens after mixed-case attribution: %s", (token) => {
    expect(pi.scrubText(`Assigned to ${token}`)).toBe(`Assigned to ${token}`);
    expect(pi.scrubText(`OWNER: ${token}`)).toBe(`OWNER: ${token}`);
  });

  it.each([
    ["assigned to owner: MSMITH", "assigned to owner: [IDIR]"],
    ["Assigned to owner: MSMITH", "Assigned to owner: [IDIR]"],
    ["owner assigned to JSMITH", "owner assigned to [IDIR]"],
    ["Owner Assigned to JSMITH", "Owner Assigned to [IDIR]"],
  ])("keeps looking after a rejected token that starts another attribution: %s", (input, expected) => {
    expect(pi.scrubText(input)).toBe(expected);
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
    expect(pi.scrubText('msg={\\"token\\":\\"abc123def\\"}')).toBe("msg={[CREDENTIAL]}");
  });

  it("still redacts the unquoted key forms", () => {
    expect(pi.scrubText("password=hunter22")).toBe("[CREDENTIAL]");
    expect(pi.scrubText("api_key: abc12345$extra")).toBe("[CREDENTIAL]");
  });
});

describe("PiScrubber.scrubText — credential grammar regressions", () => {
  let pi: PiScrubber;
  beforeEach(() => { delete process.env["RAVEN_SCRUB_PI"]; pi = new PiScrubber(); });

  it.each(["", "a", "abc", null, false, 0])("preserves JSON siblings after a short credential (%j)", (token) => {
    let input = JSON.stringify({ token, level: "ERROR", message: "Database unavailable" });
    let expected = '{[CREDENTIAL],"level":"ERROR","message":"Database unavailable"}';
    for (let depth = 0; depth < 4; depth += 1) {
      expect(pi.scrubText(input)).toBe(expected);
      input = JSON.stringify({ message: input });
      expected = JSON.stringify({ message: expected });
    }
  });

  it.each([0, 1, 2, 3])("redacts the complete value through %i JSON string encodings", (encodings) => {
    const secrets = ["Secret12 with suffix", 'prefix "quoted" suffix', "trailing backslash\\", '\\"\\"', ""];
    for (const password of secrets) {
      let input = JSON.stringify({ password, level: "ERROR", message: "Database unavailable" });
      let expected = '{[CREDENTIAL],"level":"ERROR","message":"Database unavailable"}';
      for (let i = 0; i < encodings; i += 1) {
        input = JSON.stringify({ message: input });
        expected = JSON.stringify({ message: expected });
      }
      expect(pi.scrubText(input)).toBe(expected);
    }
  });

  it.each([0, 1, 2, 3])("redacts single-quoted values through %i JSON string encodings", (encodings) => {
    for (const password of ["abcd'SECRET", "trailing backslash\\", "prefix\\'SECRET", "a b"]) {
      const escaped = password.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
      let input = `{'password':'${escaped}','level':'ERROR'}`;
      let expected = "{[CREDENTIAL],'level':'ERROR'}";
      for (let depth = 0; depth < encodings; depth += 1) {
        input = JSON.stringify({ message: input });
        expected = JSON.stringify({ message: expected });
      }
      expect(pi.scrubText(input)).toBe(expected);
    }
  });

  it("retains original JSON escape spelling when a string needs no credential redaction", () => {
    const input = String.raw`{"message":"password unavailable \u0061 \/ path \"quoted\" \\ slash"}`;
    expect(pi.scrubText(input)).toBe(input);
  });

  it("preserves diagnostic content when a changed JSON wrapper canonicalizes its escapes", () => {
    const input = String.raw`{"message":"{'password':'abcd\\'SECRET','note':'\u0061 \/ diagnostic'}"}`;
    expect(pi.scrubText(input))
      .toBe(JSON.stringify({ message: "{[CREDENTIAL],'note':'a / diagnostic'}" }));
  });

  it("preserves raw punctuation, quotes, and backslashes in the redacted value", () => {
    expect(pi.scrubText(String.raw`password=a,b}c]d"e'f\g next`)).toBe("[CREDENTIAL] next");
    expect(pi.scrubText('password="a" next')).toBe("[CREDENTIAL] next");
    expect(pi.scrubText("secret='' next")).toBe("[CREDENTIAL] next");
  });

  it("scrubs specific token formats before a generic credential consumes their label", () => {
    expect(pi.scrubText("token=Bearer abc123def456")).toBe("[CREDENTIAL] [TOKEN]");
    expect(pi.scrubText("password=SMSESSION=abc123def456")).toBe("[CREDENTIAL]");
  });

  it("handles consecutive credentials and leaves surrounding diagnostics intact", () => {
    expect(pi.scrubText('{"token":null,"password":"abc","secret":"a b","level":"ERROR"}'))
      .toBe('{[CREDENTIAL],[CREDENTIAL],[CREDENTIAL],"level":"ERROR"}');
  });

  it("bounds an unterminated quoted value at its physical log line", () => {
    expect(pi.scrubText('password="secret with suffix\nERROR next line'))
      .toBe('[CREDENTIAL]\nERROR next line');
  });

  it.each(["\n", "\r\n"])("preserves the log line after an empty raw assignment (%j)", (newline) => {
    expect(pi.scrubText(`password= \t${newline}ERROR database unavailable`))
      .toBe(`[CREDENTIAL]${newline}ERROR database unavailable`);
  });

  it("allows a structured value on the next line in formatted JSON", () => {
    expect(pi.scrubText('{"token":\r\n  "abc",\n"level":"ERROR"}'))
      .toBe('{[CREDENTIAL],\n"level":"ERROR"}');
  });

  it.each(['"', "\\"])("handles long nonmatching %j runs without quadratic backtracking", (character) => {
    const input = character.repeat(80_000);
    const start = performance.now();
    expect(pi.scrubText(input)).toBe(input);
    // The previous credential prefix took several seconds. This deliberately
    // generous budget isolates that regression from ordinary timing noise.
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// Copilot review round 4: the quoted branches treated the first quote as the
// terminator even when it was escaped, so a value containing \" was redacted
// only as far as the escape and the remainder of the secret survived.
// ---------------------------------------------------------------------------

describe("PiScrubber.scrubText — quoted values containing an escaped quote", () => {
  let pi: PiScrubber;
  beforeEach(() => { delete process.env["RAVEN_SCRUB_PI"]; pi = new PiScrubber(); });

  it("redacts through an escaped quote rather than stopping at it", () => {
    expect(pi.scrubText('{"password":"abcd\\"SECRET"}')).toBe("{[CREDENTIAL]}");
    expect(pi.scrubText("{'password':'abcd\\'SECRET'}")).toBe("{[CREDENTIAL]}");
  });

  it("still stops at the real closing quote and leaves siblings readable", () => {
    expect(pi.scrubText('{"password":"abcdef","user":"bob"}'))
      .toBe('{[CREDENTIAL],"user":"bob"}');
  });

  it("redacts a value that is only escaped quotes", () => {
    expect(pi.scrubText('{"password":"\\"\\"\\"\\""}')).toBe("{[CREDENTIAL]}");
  });
});
