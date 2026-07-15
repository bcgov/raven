import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PiScrubber } from "../src/pi-scrubber.js";

describe("PiScrubber", () => {
  let scrubber: PiScrubber;
  const originalEnv = process.env["RAVEN_SCRUB_PI"];

  beforeEach(() => {
    scrubber = new PiScrubber();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["RAVEN_SCRUB_PI"];
    } else {
      process.env["RAVEN_SCRUB_PI"] = originalEnv;
    }
  });

  describe("isEnabled", () => {
    it("returns true when env var is unset (default ON)", () => {
      delete process.env["RAVEN_SCRUB_PI"];
      expect(scrubber.isEnabled()).toBe(true);
    });

    it('returns true when env var is "true"', () => {
      process.env["RAVEN_SCRUB_PI"] = "true";
      expect(scrubber.isEnabled()).toBe(true);
    });

    it('returns true when env var is "1"', () => {
      process.env["RAVEN_SCRUB_PI"] = "1";
      expect(scrubber.isEnabled()).toBe(true);
    });

    it('returns false when env var is "false"', () => {
      process.env["RAVEN_SCRUB_PI"] = "false";
      expect(scrubber.isEnabled()).toBe(false);
    });

    it('returns false when env var is "0"', () => {
      process.env["RAVEN_SCRUB_PI"] = "0";
      expect(scrubber.isEnabled()).toBe(false);
    });
  });

  describe("scrub (disabled)", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "false";
    });

    it("returns original name when scrubbing is disabled", () => {
      expect(scrubber.scrub("Jane Smith")).toBe("Jane Smith");
    });

    it("passes through null", () => {
      expect(scrubber.scrub(null)).toBeNull();
    });

    it("passes through undefined", () => {
      expect(scrubber.scrub(undefined)).toBeUndefined();
    });
  });

  describe("scrub (enabled)", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("replaces a name with Person-1", () => {
      expect(scrubber.scrub("Jane Smith")).toBe("Person-1");
    });

    it("returns the same label for the same name", () => {
      scrubber.scrub("Jane Smith");
      expect(scrubber.scrub("Jane Smith")).toBe("Person-1");
    });

    it("assigns different labels to different names", () => {
      expect(scrubber.scrub("Jane Smith")).toBe("Person-1");
      expect(scrubber.scrub("John Doe")).toBe("Person-2");
      expect(scrubber.scrub("Alice Brown")).toBe("Person-3");
    });

    it("maintains consistency across multiple calls", () => {
      scrubber.scrub("Jane Smith");
      scrubber.scrub("John Doe");
      scrubber.scrub("Alice Brown");
      expect(scrubber.scrub("John Doe")).toBe("Person-2");
      expect(scrubber.scrub("Jane Smith")).toBe("Person-1");
      expect(scrubber.scrub("Alice Brown")).toBe("Person-3");
    });

    it("passes through null even when enabled", () => {
      expect(scrubber.scrub(null)).toBeNull();
    });

    it("passes through undefined even when enabled", () => {
      expect(scrubber.scrub(undefined)).toBeUndefined();
    });
  });

  describe("scrubText — name replacement", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("returns text unchanged when disabled", () => {
      process.env["RAVEN_SCRUB_PI"] = "false";
      scrubber.scrub("Jane Smith");
      expect(scrubber.scrubText("Jane Smith wrote this")).toBe(
        "Jane Smith wrote this"
      );
    });

    it("returns text unchanged when no names are registered", () => {
      expect(scrubber.scrubText("Some random text")).toBe("Some random text");
    });

    it("replaces known names in text", () => {
      scrubber.scrub("Jane Smith");
      expect(scrubber.scrubText("Jane Smith filed this issue")).toBe(
        "Person-1 filed this issue"
      );
    });

    it("replaces multiple different names", () => {
      scrubber.scrub("Jane Smith");
      scrubber.scrub("John Doe");
      const text =
        "Jane Smith assigned this to John Doe. Jane Smith also commented.";
      expect(scrubber.scrubText(text)).toBe(
        "Person-1 assigned this to Person-2. Person-1 also commented."
      );
    });

    it("does not replace unknown names", () => {
      scrubber.scrub("Jane Smith");
      expect(scrubber.scrubText("Bob Jones wrote this")).toBe(
        "Bob Jones wrote this"
      );
    });

    it("handles longer names before shorter to avoid partial matches", () => {
      scrubber.scrub("Jane Smith");
      scrubber.scrub("Jane Smith-Jones");
      const text = "Jane Smith-Jones reviewed the PR";
      expect(scrubber.scrubText(text)).toBe("Person-2 reviewed the PR");
    });
  });

  describe("scrubText — email addresses", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("scrubs simple email addresses", () => {
      expect(scrubber.scrubText("Contact jane.smith@gov.bc.ca")).toBe(
        "Contact [EMAIL]"
      );
    });

    it("scrubs multiple emails in one string", () => {
      expect(
        scrubber.scrubText("From alice@example.com to bob@example.org")
      ).toBe("From [EMAIL] to [EMAIL]");
    });

    it("scrubs emails with plus addressing", () => {
      expect(scrubber.scrubText("Send to user+tag@gmail.com")).toBe(
        "Send to [EMAIL]"
      );
    });
  });

  describe("scrubText — phone numbers", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("scrubs dashed phone numbers", () => {
      expect(scrubber.scrubText("Call 250-555-1234")).toBe("Call [PHONE]");
    });

    it("scrubs parenthesized area codes", () => {
      expect(scrubber.scrubText("Call (250) 555-1234")).toBe("Call [PHONE]");
    });

    it("scrubs dotted phone numbers", () => {
      expect(scrubber.scrubText("Call 250.555.1234")).toBe("Call [PHONE]");
    });

    it("scrubs phone with country code", () => {
      expect(scrubber.scrubText("Call +1-250-555-1234")).toBe("Call [PHONE]");
    });

    it("scrubs 1-800 numbers", () => {
      expect(scrubber.scrubText("Call 1-800-555-1234")).toBe("Call [PHONE]");
    });
  });

  describe("scrubText — IDIR usernames", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("scrubs IDIR email format", () => {
      expect(scrubber.scrubText("Login as JSMITH@idir")).toBe(
        "Login as [IDIR]"
      );
    });

    it("scrubs IDIR with mixed case", () => {
      expect(scrubber.scrubText("User jsmith@IDIR logged in")).toBe(
        "User [IDIR] logged in"
      );
    });

    it("scrubs author: PREFIX format", () => {
      expect(scrubber.scrubText("author: JSMITH committed")).toBe(
        "[IDIR] committed"
      );
    });
  });

  describe("scrubText — SIN (Social Insurance Numbers)", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("scrubs dashed SIN", () => {
      expect(scrubber.scrubText("SIN: 123-456-789")).toBe("SIN: [SIN]");
    });

    it("scrubs spaced SIN", () => {
      expect(scrubber.scrubText("SIN: 123 456 789")).toBe("SIN: [SIN]");
    });
  });

  describe("scrubText — tokens and credentials", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("scrubs SMSESSION tokens", () => {
      const text = "Cookie: SMSESSION=abc123def456ghi789jkl012mno345";
      expect(scrubber.scrubText(text)).toBe("Cookie: SMSESSION=[TOKEN]");
    });

    it("scrubs Bearer tokens", () => {
      const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";
      expect(scrubber.scrubText(text)).toBe("Authorization: Bearer [TOKEN]");
    });

    it("scrubs api_key values", () => {
      const text = 'api_key=abcdef1234567890abcdef1234567890';
      expect(scrubber.scrubText(text)).toBe("[CREDENTIAL]");
    });

    it("scrubs password values", () => {
      const text = "password: supersecretpassword123";
      expect(scrubber.scrubText(text)).toBe("[CREDENTIAL]");
    });
  });

  describe("scrubText — combined patterns", () => {
    beforeEach(() => {
      process.env["RAVEN_SCRUB_PI"] = "true";
    });

    it("scrubs multiple PI types in one string", () => {
      scrubber.scrub("Jane Smith");
      const text =
        "Jane Smith (jane.smith@gov.bc.ca, 250-555-1234) logged in as JSMITH@idir";
      const result = scrubber.scrubText(text);
      expect(result).toContain("Person-1");
      expect(result).toContain("[EMAIL]");
      expect(result).toContain("[PHONE]");
      expect(result).toContain("[IDIR]");
      expect(result).not.toContain("Jane Smith");
      expect(result).not.toContain("jane.smith@gov.bc.ca");
      expect(result).not.toContain("250-555-1234");
      expect(result).not.toContain("JSMITH");
    });
  });

  describe("reset", () => {
    it("clears the name mapping and restarts numbering", () => {
      process.env["RAVEN_SCRUB_PI"] = "true";
      expect(scrubber.scrub("Jane Smith")).toBe("Person-1");
      expect(scrubber.scrub("John Doe")).toBe("Person-2");

      scrubber.reset();

      expect(scrubber.scrub("Alice Brown")).toBe("Person-1");
      expect(scrubber.scrub("Jane Smith")).toBe("Person-2");
    });
  });
});
