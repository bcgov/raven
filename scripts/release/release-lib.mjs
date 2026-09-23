import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** Absolute path to the Raven repository root. */
export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
/** Canonical versioned server catalog path. */
export const catalogPath = join(repoRoot, "release", "server-catalog.json");
/** Canonical bundled Node.js version file. */
export const nodeVersionPath = join(repoRoot, ".node-version");
const SEMVER_CORE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Read and parse a JSON file. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Calculate a file's lowercase SHA-256 digest. */
export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Return whether a string is a strict major.minor.patch SemVer core. */
export function isSemVerCore(value) {
  return typeof value === "string" && SEMVER_CORE.test(value);
}

/** Run Git against the Raven repository and return trimmed stdout. */
export function git(...args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Return every launcher entry included in a runtime bundle. */
export function releasedEntries(catalog) {
  return [...catalog.servers, ...(catalog.utilities ?? [])];
}

/** Compare two strict SemVer core versions. */
export function compareSemVerCore(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

/** Return whether a version needs the independent major-release marker. */
export function requiresMajorApproval(version, previousVersions) {
  if (!isSemVerCore(version))
    throw new Error(`Invalid suite version '${version}'.`);
  const validPrevious = previousVersions
    .filter(isSemVerCore)
    .filter((previousVersion) => previousVersion !== version);
  if (validPrevious.length === 0) return false;
  const latest = validPrevious.sort(compareSemVerCore).at(-1);
  if (compareSemVerCore(version, latest) <= 0) {
    throw new Error(
      `Candidate version ${version} must be newer than latest release ${latest}.`,
    );
  }
  return Number(version.split(".")[0]) > Number(latest.split(".")[0]);
}

/** Validate the committed approval marker required for a major-version increase. */
export function assertMajorReleaseApproval(version) {
  const previousVersions = git("tag", "--list", "v*")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => tag.replace(/^v/, ""));
  if (!requiresMajorApproval(version, previousVersions)) return false;

  const markerRelative = `.github/release-major/v${version}.json`;
  const markerPath = join(repoRoot, ...markerRelative.split("/"));
  if (!existsSync(markerPath)) {
    throw new Error(
      `Major release ${version} requires reviewed approval at ${markerRelative}.`,
    );
  }
  const marker = readJson(markerPath);
  if (
    marker.schemaVersion !== 1 ||
    marker.version !== version ||
    marker.approved !== true
  ) {
    throw new Error(`Major release approval is malformed: ${markerRelative}.`);
  }
  git("ls-files", "--error-unmatch", "--", markerRelative);
  return true;
}

/** Validate catalog, workspace, runtime, and MCP configuration consistency. */
export function validateCatalog(catalog = readJson(catalogPath)) {
  const rootPackage = readJson(join(repoRoot, "package.json"));
  const packageLock = readJson(join(repoRoot, "package-lock.json"));
  const mcp = readJson(join(repoRoot, ".mcp.json"));
  const pinnedNodeVersion = readFileSync(nodeVersionPath, "utf8").trim();
  if (
    catalog.schemaVersion !== 1 ||
    !isSemVerCore(catalog.suiteVersion) ||
    catalog.suiteVersion !== rootPackage.version
  ) {
    throw new Error(
      "Release catalog schema or suite version does not match package.json.",
    );
  }
  if (
    !isSemVerCore(pinnedNodeVersion) ||
    catalog.nodeVersion !== pinnedNodeVersion
  ) {
    throw new Error(
      "Release catalog Node.js version must match the reviewed .node-version.",
    );
  }
  if (!Array.isArray(catalog.servers) || catalog.servers.length === 0) {
    throw new Error("Release catalog contains no servers.");
  }
  if (
    packageLock.packages?.[""]?.version !== catalog.suiteVersion ||
    rootPackage.workspaces.some((workspace) => {
      const workspacePackage = readJson(
        join(repoRoot, workspace, "package.json"),
      );
      return (
        workspacePackage.version !== catalog.suiteVersion ||
        packageLock.packages?.[workspace]?.version !== catalog.suiteVersion
      );
    })
  ) {
    throw new Error(
      "Every workspace and package-lock entry must use the Raven suite version.",
    );
  }
  const ids = new Set();
  const launchers = new Set();
  for (const entry of releasedEntries(catalog)) {
    if (!/^[a-z][a-z0-9-]+$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`Invalid or duplicate release entry ID: ${entry.id}`);
    }
    if (
      !/^[a-z][a-z0-9-]+$/.test(entry.launcher) ||
      launchers.has(entry.launcher)
    ) {
      throw new Error(`Invalid or duplicate launcher: ${entry.launcher}`);
    }
    ids.add(entry.id);
    launchers.add(entry.launcher);
    const packageDir = entry.entrypoint.split("/").slice(0, 2).join("/");
    const packageJson = readJson(
      join(repoRoot, ...packageDir.split("/"), "package.json"),
    );
    if (
      packageJson.name !== entry.package ||
      packageJson.version !== entry.packageVersion
    ) {
      throw new Error(`Catalog package metadata for '${entry.id}' is stale.`);
    }
  }
  for (const server of catalog.servers) {
    const configured = mcp.mcpServers?.[server.id];
    if (
      configured?.command !== "node" ||
      configured.args?.length !== 1 ||
      configured.args[0].replaceAll("\\", "/").replace(/^\.\//, "") !==
        server.entrypoint
    ) {
      throw new Error(`Catalog entry '${server.id}' does not match .mcp.json.`);
    }
  }
  const configuredIds = Object.keys(mcp.mcpServers ?? {});
  const serverIds = new Set(catalog.servers.map((server) => server.id));
  if (
    configuredIds.some((id) => !serverIds.has(id)) ||
    serverIds.size !== configuredIds.length
  ) {
    throw new Error(
      "Release catalog and .mcp.json contain different server IDs.",
    );
  }
  return catalog;
}

/** Copy production dependencies while excluding generated bins and caches. */
export function copyProductionModules(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const rel = relative(source, path).split(sep).join("/");
      if (!rel) return true;
      const segments = rel.split("/");
      if (
        segments.some((segment) =>
          [".bin", ".cache", ".vite"].includes(segment),
        ) ||
        rel === ".package-lock.json" ||
        rel === "@nrs" ||
        rel.startsWith("@nrs/")
      ) {
        return false;
      }
      return !lstatSync(path).isSymbolicLink();
    },
  });
}

/** Locate the licence for the Node.js executable being bundled. */
export function findNodeLicense(executable = process.execPath) {
  const configured = process.env.NODE_RUNTIME_LICENSE;
  if (configured) {
    const candidate = resolve(configured);
    if (!existsSync(candidate)) {
      throw new Error(`NODE_RUNTIME_LICENSE does not exist: ${candidate}`);
    }
    return candidate;
  }
  let current = dirname(executable);
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of ["LICENSE", "LICENSE.txt"]) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Could not locate the licence for the bundled Node.js runtime near ${executable}.`,
  );
}

/** Copy compiled Raven workspace packages into the runtime node_modules tree. */
export function copyWorkspacePackages(destination) {
  const packagesDir = join(repoRoot, "packages");
  for (const name of readdirSync(packagesDir)) {
    const source = join(packagesDir, name);
    const packagePath = join(source, "package.json");
    const distPath = join(source, "dist");
    if (!existsSync(packagePath) || !existsSync(distPath)) continue;
    const metadata = readJson(packagePath);
    if (!metadata.name?.startsWith("@nrs/")) continue;
    const target = join(destination, ...metadata.name.split("/"));
    mkdirSync(target, { recursive: true });
    cpSync(packagePath, join(target, "package.json"));
    cpSync(distPath, join(target, "dist"), { recursive: true });
    for (const runtimeAsset of ["public", "sonar.config"]) {
      const assetPath = join(source, runtimeAsset);
      if (existsSync(assetPath)) {
        cpSync(assetPath, join(target, runtimeAsset), { recursive: true });
      }
    }
  }
}

/** Generate native launchers for all catalog servers and utilities. */
export function writeLaunchers(
  bundleRoot,
  catalog,
  platform = process.platform,
) {
  const binDir = join(bundleRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const entry of releasedEntries(catalog)) {
    const packageRelative = runtimeEntrypoint(entry);
    if (platform === "win32") {
      const entrypoint = packageRelative.replaceAll("/", "\\");
      const content = `@echo off\r\nset "PATH=%~dp0..\\runtime;%PATH%"\r\nset "RAVEN_BUNDLED_RUNTIME=1"\r\nif not "%RAVEN_RELEASE_LAUNCHER_CHECK%"=="1" goto run\r\n"%~dp0..\\runtime\\node.exe" --check "%~dp0..\\runtime\\${entrypoint}"\r\nexit /b %ERRORLEVEL%\r\n:run\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\runtime\\${entrypoint}" %*\r\n`;
      writeFileSync(join(binDir, `${entry.launcher}.cmd`), content, "utf8");
    } else {
      const content = `#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nPATH="$SCRIPT_DIR/../runtime:$PATH"\nRAVEN_BUNDLED_RUNTIME=1\nexport PATH RAVEN_BUNDLED_RUNTIME\nif [ "\${RAVEN_RELEASE_LAUNCHER_CHECK:-}" = "1" ]; then\n  exec "$SCRIPT_DIR/../runtime/node" --check "$SCRIPT_DIR/../runtime/${packageRelative}"\nfi\nexec "$SCRIPT_DIR/../runtime/node" "$SCRIPT_DIR/../runtime/${packageRelative}" "$@"\n`;
      const path = join(binDir, entry.launcher);
      writeFileSync(path, content, "utf8");
      chmodSync(path, 0o755);
    }
  }
}

/** Map a catalog source entrypoint into the bundled runtime tree. */
export function runtimeEntrypoint(entry) {
  const [, , ...entrypointParts] = entry.entrypoint.split("/");
  if (entrypointParts.length === 0) {
    throw new Error(`Invalid catalog entrypoint for '${entry.id}'.`);
  }
  return ["node_modules", ...entry.package.split("/"), ...entrypointParts].join(
    "/",
  );
}

function launcherInvocation(bundleRoot, entry) {
  const launcher = join(
    bundleRoot,
    "bin",
    `${entry.launcher}${process.platform === "win32" ? ".cmd" : ""}`,
  );
  return process.platform === "win32"
    ? {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/c", launcher],
      }
    : { command: launcher, args: [] };
}

function validateLauncher(bundleRoot, entry) {
  const { command, args } = launcherInvocation(bundleRoot, entry);
  const result = spawnSync(command, args, {
    cwd: bundleRoot,
    env: { ...process.env, RAVEN_RELEASE_LAUNCHER_CHECK: "1" },
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${entry.id} launcher failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

function releaseSmokeEnvironment(home) {
  const names = [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TMPDIR",
    "TEMP",
    "TMP",
  ];
  const environment = Object.fromEntries(
    names
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    RAVEN_RELEASE_SMOKE_TEST: "1",
  };
}

/** Syntax-check every launcher and start each server through its launcher. */
export async function smokeTest(bundleRoot, catalog, timeoutMs = 1500) {
  for (const entry of releasedEntries(catalog)) {
    validateLauncher(bundleRoot, entry);
  }
  const smokeHome = mkdtempSync(join(tmpdir(), "raven-release-smoke-"));
  try {
    const smokeBin = join(smokeHome, "bin");
    mkdirSync(smokeBin, { recursive: true });
    cpSync(
      join(repoRoot, "servers.conf.example"),
      join(smokeBin, "servers.conf"),
    );
    for (const server of catalog.servers) {
      const { command, args } = launcherInvocation(bundleRoot, server);
      await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
          cwd: bundleRoot,
          env: releaseSmokeEnvironment(smokeHome),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let output = "";
        let expectedStop = false;
        const capture = (chunk) => {
          if (output.length < 2000) output += chunk.toString();
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => {
          if (expectedStop) resolvePromise();
          else
            rejectPromise(
              new Error(
                `${server.id} launcher exited during smoke test (${code ?? signal}): ${output.trim()}`,
              ),
            );
        });
        setTimeout(() => {
          expectedStop = true;
          child.stdin.end();
          child.kill();
        }, timeoutMs);
      });
    }
  } finally {
    rmSync(smokeHome, { recursive: true, force: true });
  }
}

/** Create the compressed platform bundle archive. */
export function createArchive(bundleRoot, archivePath) {
  const result = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", dirname(bundleRoot), basename(bundleRoot)],
    { encoding: "utf8", shell: false },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `tar failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

/** Replace a directory with a newly created empty directory. */
export function resetDirectory(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}
