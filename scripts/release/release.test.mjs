import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  isSemVerCore,
  copyWorkspacePackages,
  copySetupScripts,
  readJson,
  releasedEntries,
  requiresMajorApproval,
  smokeTest,
  validateCatalog,
  validateRemoteMcpEntry,
  writeLaunchers,
} from "./release-lib.mjs";

test("release catalog matches package metadata and MCP configuration", () => {
  const catalog = validateCatalog();
  assert.equal(isSemVerCore(catalog.suiteVersion), true);
  assert.ok(catalog.servers.length > 0);
  assert.ok(releasedEntries(catalog).length > catalog.servers.length);
});

test("hosted Sysdig OAuth MCP uses remote HTTP and is excluded from bundled servers", () => {
  const catalog = validateCatalog();
  const mcp = readJson(new URL("../../.mcp.json", import.meta.url));
  const sysdig = mcp.mcpServers["sysdig-secure-mcp"];

  assert.deepEqual(sysdig, {
    type: "http",
    url: "https://secure.sysdig.com/mcp/secure",
  });
  assert.equal(catalog.servers.some(({ id }) => id === "sysdig-secure-mcp"), false);
});

test("remote MCP entries must be approved, credential-free HTTPS endpoints", () => {
  const ok = { type: "http", url: "https://secure.sysdig.com/mcp/secure" };
  assert.doesNotThrow(() => validateRemoteMcpEntry("sysdig-secure-mcp", ok));
  assert.doesNotThrow(() =>
    validateRemoteMcpEntry("sysdig-secure-mcp", { ...ok, url: "https://eu1.app.sysdig.com/mcp/secure" }),
  );
  const rejected = [
    ["unreviewed", ok, /not an approved remote server/],
    ["__proto__", ok, /not an approved remote server/],
    ["sysdig-secure-mcp", { ...ok, headers: { Authorization: "Bearer x" } }, /only "type": "http" and "url"/],
    ["sysdig-secure-mcp", { ...ok, type: "sse" }, /only "type": "http" and "url"/],
    ["sysdig-secure-mcp", { ...ok, url: "not a url" }, /valid HTTPS URL/],
    ["sysdig-secure-mcp", { ...ok, url: "http://secure.sysdig.com/mcp/secure" }, /approved HTTPS endpoint/],
    ["sysdig-secure-mcp", { ...ok, url: "https://attacker.example/mcp/secure" }, /approved HTTPS endpoint/],
    ["sysdig-secure-mcp", { ...ok, url: "https://sysdig.com.attacker.example/mcp/secure" }, /approved HTTPS endpoint/],
    ["sysdig-secure-mcp", { ...ok, url: "https://user:pw@secure.sysdig.com/mcp/secure" }, /approved HTTPS endpoint/],
    ["sysdig-secure-mcp", { ...ok, url: "https://secure.sysdig.com/mcp/secure?token=x" }, /approved HTTPS endpoint/],
    ["sysdig-secure-mcp", { ...ok, url: "https://secure.sysdig.com/other" }, /approved HTTPS endpoint/],
  ];
  for (const [id, entry, message] of rejected) {
    assert.throws(() => validateRemoteMcpEntry(id, entry), message, `${id} ${JSON.stringify(entry)}`);
  }
});

test("major version increases require independent approval", () => {
  assert.equal(requiresMajorApproval("0.2.0", ["0.1.0"]), false);
  assert.equal(requiresMajorApproval("1.0.0", ["0.9.0"]), true);
  assert.equal(requiresMajorApproval("2.1.0", ["1.8.4", "2.0.0"]), false);
  assert.equal(requiresMajorApproval("1.0.0", []), false);
  assert.throws(
    () => requiresMajorApproval("1.9.0", ["2.0.0"]),
    /must be newer than latest release 2\.0\.0/,
  );
  assert.equal(
    requiresMajorApproval("2.0.0", ["1.9.0", "2.0.0"]),
    true,
  );
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
    utilities: [
      {
        id: "auth",
        package: "@nrs/auth",
        launcher: "raven-auth",
        entrypoint: "packages/auth/dist/cli.js",
      },
    ],
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
  assert.match(launcher, /RAVEN_BUNDLED_RUNTIME=1/);
  assert.match(
    readFileSync(join(directory, "bin", "raven-auth"), "utf8"),
    /node_modules\/@nrs\/auth\/dist\/cli\.js/,
  );

  writeLaunchers(directory, catalog, "win32");
  const windowsLauncher = readFileSync(
    join(directory, "bin", "raven-jira.cmd"),
    "utf8",
  );
  assert.match(windowsLauncher, /runtime\\node\.exe/);
  assert.match(windowsLauncher, /set "PATH=.*runtime;%PATH%"/);
  assert.match(
    windowsLauncher,
    /node_modules\\@nrs\\jira-mcp\\dist\\index\.js/,
  );
  assert.match(windowsLauncher, /goto run/);
  assert.match(windowsLauncher, /exit \/b %ERRORLEVEL%\r\n:run/);
  assert.match(
    readFileSync(join(directory, "bin", "raven-auth.cmd"), "utf8"),
    /node_modules\\@nrs\\auth\\dist\\cli\.js/,
  );
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
  assert.equal(
    catalog.nodeVersion,
    readFileSync(
      new URL("../../.node-version", import.meta.url),
      "utf8",
    ).trim(),
  );
});

test("workspace packages include package-root runtime assets", () => {
  const directory = mkdtempSync(join(tmpdir(), "raven-workspaces-"));
  copyWorkspacePackages(directory);

  const bundledConfig = join(
    directory,
    "@nrs",
    "sonar-mcp",
    "sonar.config",
  );
  assert.equal(existsSync(bundledConfig), true);
  assert.equal(
    readFileSync(bundledConfig, "utf8"),
    readFileSync(
      new URL("../../packages/sonar-mcp/sonar.config", import.meta.url),
      "utf8",
    ),
  );
});

test("release bundle includes both credential setup scripts and their helper", () => {
  const directory = mkdtempSync(join(tmpdir(), "raven-setup-bundle-"));
  try {
    copySetupScripts(directory);
    for (const name of [
      "setup-credentials.ps1",
      "setup-credentials-mac.mjs",
      "setup-credentials-mac.lib.mjs",
    ]) {
      assert.equal(
        readFileSync(join(directory, "scripts", name), "utf8"),
        readFileSync(new URL(`../${name}`, import.meta.url), "utf8"),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release smoke test seeds the isolated server inventory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raven-smoke-bundle-"));
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const probe = join(directory, "server-monitor-probe.mjs");
  writeFileSync(
    probe,
    'import { existsSync } from "node:fs";\n' +
      'import { join } from "node:path";\n' +
      'if (!existsSync(join(process.env.HOME, "bin", "servers.conf"))) process.exit(2);\n' +
    "setTimeout(() => process.exit(0), 1200);\n" +
    "setInterval(() => {}, 1000);\n",
  );

  const launcher = join(
    binDirectory,
    `raven-server-monitor${process.platform === "win32" ? ".cmd" : ""}`,
  );
  if (process.platform === "win32") {
    writeFileSync(
      launcher,
      `@echo off\r\nif "%RAVEN_RELEASE_LAUNCHER_CHECK%"=="1" exit /b 0\r\n"${process.execPath}" "${probe}"\r\n`,
    );
  } else {
    writeFileSync(
      launcher,
      `#!/bin/sh\nif [ "\${RAVEN_RELEASE_LAUNCHER_CHECK:-}" = "1" ]; then exit 0; fi\nexec "${process.execPath}" "${probe}"\n`,
    );
    chmodSync(launcher, 0o755);
  }

  try {
    await smokeTest(
      directory,
      {
        servers: [
          {
            id: "server-monitor",
            launcher: "raven-server-monitor",
          },
        ],
      },
      1000,
    );
  } finally {
    if (process.platform === "win32") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});
