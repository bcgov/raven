import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findUnquotedHashKeys, loadEnvVar } from "../load-env.js";

let tmpDir: string | undefined;

function envFile(content: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), "raven-env-test-"));
  const path = join(tmpDir, ".env");
  writeFileSync(path, content, "utf-8");
  return path;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  delete process.env["RAVEN_TEST_VAR"];
});

describe("loadEnvVar", () => {
  it("returns a plain unquoted value", () => {
    const path = envFile("RAVEN_TEST_VAR=hello\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBe("hello");
  });

  it("preserves special characters inside a double-quoted value", () => {
    const path = envFile('RAVEN_TEST_VAR="pa#s\'w$rd"\n');
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBe("pa#s'w$rd");
  });

  it("preserves special characters inside a single-quoted value", () => {
    const path = envFile("RAVEN_TEST_VAR='pa#s\"w$rd'\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBe('pa#s"w$rd');
  });

  it("keeps a literal trailing quote that is part of an unquoted value", () => {
    // The old hand-rolled parsers stripped this and corrupted the password.
    const path = envFile("RAVEN_TEST_VAR=pass'\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBe("pass'");
  });

  it("parses values with = signs, spaces around =, and export prefixes", () => {
    const path = envFile("export RAVEN_TEST_VAR = a=b=c\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBe("a=b=c");
  });

  it("prefers an existing process.env value over the file", () => {
    process.env["RAVEN_TEST_VAR"] = "from-env";
    const path = envFile("RAVEN_TEST_VAR=from-file\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBe("from-env");
  });

  it("treats an explicitly empty process.env value as cleared, not unset", () => {
    // Matches dotenv override:false — an existing (even empty) env var wins,
    // so a deliberately cleared credential is not re-enabled from the file.
    process.env["RAVEN_TEST_VAR"] = "";
    const path = envFile("RAVEN_TEST_VAR=from-file\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBeUndefined();
  });

  it("returns undefined for a missing key", () => {
    const path = envFile("OTHER=value\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBeUndefined();
  });

  it("returns undefined for an empty value", () => {
    const path = envFile("RAVEN_TEST_VAR=\n");
    expect(loadEnvVar("RAVEN_TEST_VAR", path)).toBeUndefined();
  });

  it("returns undefined when the file does not exist", () => {
    expect(loadEnvVar("RAVEN_TEST_VAR", "/nonexistent/.env")).toBeUndefined();
  });
});

describe("findUnquotedHashKeys", () => {
  it("flags an unquoted value with a # glued to text (silent truncation)", () => {
    expect(findUnquotedHashKeys("PASSWORD=pa#ss\n")).toEqual(["PASSWORD"]);
  });

  it("does not flag a double-quoted value containing #", () => {
    expect(findUnquotedHashKeys('PASSWORD="pa#ss"\n')).toEqual([]);
  });

  it("does not flag a single-quoted value containing #", () => {
    expect(findUnquotedHashKeys("PASSWORD='pa#ss'\n")).toEqual([]);
  });

  it("does not flag an intentional inline comment separated by a space", () => {
    expect(findUnquotedHashKeys("PASSWORD=hunter2 # prod creds\n")).toEqual([]);
  });

  it("does not flag full-line comments or blank lines", () => {
    expect(findUnquotedHashKeys("# a comment\n\nKEY=value\n")).toEqual([]);
  });

  it("flags a value whose leading quote is never closed", () => {
    // dotenv parses PASSWORD="pa#ss as the unquoted value '"pa' — truncated
    // and keeping the literal quote — so it must be warned about.
    expect(findUnquotedHashKeys('PASSWORD="pa#ss\n')).toEqual(["PASSWORD"]);
    expect(findUnquotedHashKeys("PASSWORD='pa#ss\n")).toEqual(["PASSWORD"]);
  });

  it("does not flag a closed quoted value followed by an inline comment", () => {
    expect(findUnquotedHashKeys('PASSWORD="ok" # comment\n')).toEqual([]);
  });

  it("does not flag an empty value followed by a comment", () => {
    // dotenv parses this as PASSWORD="" — the '#' is separated by whitespace.
    expect(findUnquotedHashKeys("PASSWORD= # not configured\n")).toEqual([]);
  });

  it("does not flag a multiline quoted value containing #", () => {
    expect(findUnquotedHashKeys('TOKEN="part#one\npart-two"\n')).toEqual([]);
  });

  it("skips a multiline value's continuation lines but scans what follows", () => {
    const content = 'TOKEN="line#1\nmid=x#y\nend"\nAFTER=ok#bad\n';
    // mid=x#y is inside TOKEN's quoted value; AFTER really is truncated.
    expect(findUnquotedHashKeys(content)).toEqual(["AFTER"]);
  });

  it("still flags an unclosed quote even when a later key is quoted", () => {
    // dotenv truncates A to '"pa' here — the quote does not span into B.
    expect(findUnquotedHashKeys('A="pa#ss\nB="ok"\n')).toEqual(["A"]);
  });

  it("flags each affected key once across a multi-line file", () => {
    const content = [
      "A=ok",
      "B=bad#value",
      'C="fine#quoted"',
      "D=also#bad",
    ].join("\n");
    expect(findUnquotedHashKeys(content)).toEqual(["B", "D"]);
  });
});
