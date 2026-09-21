import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  isSemVerCore,
  readJson,
  validateCatalog,
  writeLaunchers,
} from "./release-lib.mjs";

test("release catalog matches package metadata and MCP configuration", () => {
  const catalog = validateCatalog();
  assert.equal(isSemVerCore(catalog.suiteVersion), true);
  assert.equal(catalog.servers.length, 17);
});

test("suite versions accept SemVer core without leading zeroes", () => {
  for (const version of ["0.1.0", "0.2.0", "1.0.0", "12.34.56"]) {
    assert.equal(isSemVerCore(version), true, version);
  }
  for (const version of ["01.2.3", "1.02.3", "1.2.03", "1.2", "v1.2.3"]) {
    assert.equal(isSemVerCore(version), false, version);
  }
});

test("launchers use bundled Node and package entrypoints", () => {
  const directory = mkdtempSync(join(tmpdir(), "raven-release-"));
  const catalog = {
    servers: [
      {
        id: "jira",
        package: "@nrs/jira-mcp",
        launcher: "raven-jira",
        entrypoint: "packages/jira-mcp/dist/index.js",
      },
    ],
  };
  writeLaunchers(directory, catalog, "linux");
  const launcher = readFileSync(join(directory, "bin", "raven-jira"), "utf8");
  assert.match(launcher, /runtime\/node/);
  assert.match(launcher, /node_modules\/@nrs\/jira-mcp\/dist\/index\.js/);

  writeLaunchers(directory, catalog, "win32");
  const windowsLauncher = readFileSync(
    join(directory, "bin", "raven-jira.cmd"),
    "utf8",
  );
  assert.match(windowsLauncher, /runtime\\node\.exe/);
  assert.match(
    windowsLauncher,
    /node_modules\\@nrs\\jira-mcp\\dist\\index\.js/,
  );
  assert.match(windowsLauncher, /goto run/);
  assert.match(windowsLauncher, /exit \/b %ERRORLEVEL%\r\n:run/);
});

test("catalog is valid JSON with an explicit platform contract", () => {
  const catalog = readJson(
    new URL("../../release/server-catalog.json", import.meta.url),
  );
  assert.deepEqual(catalog.supportedPlatforms, [
    "darwin-x64",
    "linux-x64",
    "win32-x64",
  ]);
  assert.equal(catalog.nodeVersion, "24.21.0");
});
