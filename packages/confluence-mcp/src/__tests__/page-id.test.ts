import { describe, it, expect } from "vitest";
import { parsePageId } from "../page-id.js";

describe("parsePageId", () => {
  describe("viewpage.action?pageId= URLs", () => {
    it("extracts pageId from a full viewpage.action URL", () => {
      expect(
        parsePageId(
          "https://apps.example.gov.bc.ca/int/confluence/pages/viewpage.action?pageId=298126062"
        )
      ).toBe("298126062");
    });

    it("extracts pageId from a bare viewpage.action path (no host)", () => {
      expect(
        parsePageId("/pages/viewpage.action?pageId=298126062")
      ).toBe("298126062");
    });

    it("handles extra query parameters alongside pageId", () => {
      expect(
        parsePageId(
          "https://apps.example.gov.bc.ca/int/confluence/pages/viewpage.action?pageId=298126062&focusedCommentId=123"
        )
      ).toBe("298126062");
    });
  });

  describe("/pages/<id> path URLs", () => {
    it("extracts ID from /pages/<id> path only", () => {
      expect(
        parsePageId("/pages/298126062")
      ).toBe("298126062");
    });

    it("extracts ID from /pages/<id>/Some-Title path", () => {
      expect(
        parsePageId("/pages/298126062/Some-Title")
      ).toBe("298126062");
    });

    it("extracts ID from a full /pages/<id> URL", () => {
      expect(
        parsePageId(
          "https://apps.example.gov.bc.ca/int/confluence/pages/298126062"
        )
      ).toBe("298126062");
    });

    it("extracts ID from a full /pages/<id>/Some-Title URL", () => {
      expect(
        parsePageId(
          "https://apps.example.gov.bc.ca/int/confluence/pages/298126062/Some-Title"
        )
      ).toBe("298126062");
    });
  });

  describe("plain numeric IDs", () => {
    it("passes through a plain numeric string unchanged", () => {
      expect(parsePageId("298126062")).toBe("298126062");
    });

    it("trims leading and trailing whitespace before parsing", () => {
      expect(parsePageId("  298126062  ")).toBe("298126062");
    });

    it("trims whitespace from a URL", () => {
      expect(
        parsePageId(
          "  https://apps.example.gov.bc.ca/int/confluence/pages/viewpage.action?pageId=298126062  "
        )
      ).toBe("298126062");
    });
  });

  describe("invalid inputs", () => {
    it("throws for a non-URL, non-numeric string", () => {
      expect(() => parsePageId("not-a-page-id")).toThrow(
        'Cannot extract a Confluence page ID from: "not-a-page-id"'
      );
    });

    it("throws for a URL with no recognisable page ID pattern", () => {
      expect(() =>
        parsePageId("https://apps.example.gov.bc.ca/int/confluence/spaces/MYSPACE")
      ).toThrow(
        'Cannot extract a Confluence page ID from: "https://apps.example.gov.bc.ca/int/confluence/spaces/MYSPACE"'
      );
    });

    it("throws for an empty string", () => {
      expect(() => parsePageId("")).toThrow(
        'Cannot extract a Confluence page ID from: ""'
      );
    });
  });
});
