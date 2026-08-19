import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// isValidBranchName (branch-validation.ts)
// --branch values reach git checkout argv and refs/heads/<name> PR targets.
// Beyond option injection, malformed ref names must be rejected up front —
// a bad branch otherwise fails mid-run at IMPLEMENT, after a ticket exists.
// ---------------------------------------------------------------------------

import { isValidBranchName } from "../src/branch-validation.js";

describe("isValidBranchName", () => {
  it.each([
    "main",
    "master",
    "feature/DMS-310",
    "release/1.5.2",
    "bugfix/dms-364-fix",
    "vendor/develop",
    "v2.0.0",
  ])("accepts real-world branch name %s", (name) => {
    expect(isValidBranchName(name)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["HEAD", "HEAD is not a branch"],
    ["-rf", "leading dash (option injection)"],
    ["foo..bar", "double dot"],
    ["foo//bar", "empty component"],
    ["foo/", "trailing slash"],
    ["foo.", "trailing dot"],
    ["foo.lock", "component ending in .lock"],
    ["feature/foo.lock", "last component ending in .lock"],
    ["foo.lock/bar", "inner component ending in .lock"],
    ["/foo", "leading slash"],
    ["foo/.hidden", "component starting with dot"],
    ["foo bar", "whitespace"],
    ["foo~1", "tilde"],
    ["foo^2", "caret"],
    ["foo:bar", "colon"],
    ["foo?", "glob character"],
    ["foo[1]", "bracket"],
    ["foo\\bar", "backslash"],
    ["foo@{1}", "reflog syntax"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});
