import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const catalogPath = join(repoRoot, "release", "server-catalog.json");

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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

export function validateCatalog(catalog = readJson(catalogPath)) {
  const rootPackage = readJson(join(repoRoot, "package.json"));
  const packageLock = readJson(join(repoRoot, "package-lock.json"));
  const mcp = readJson(join(repoRoot, ".mcp.json"));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.suiteVersion !== rootPackage.version
  ) {
    throw new Error(
      "Release catalog schema or suite version does not match package.json.",
    );
  }
  if (catalog.nodeVersion !== "24.21.0") {
    throw new Error("Release catalog must pin the reviewed Node.js runtime.");
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
  for (const server of catalog.servers) {
    if (!/^[a-z][a-z0-9-]+$/.test(server.id) || ids.has(server.id)) {
      throw new Error(`Invalid or duplicate server ID: ${server.id}`);
    }
    ids.add(server.id);
    const configured = mcp.mcpServers?.[server.id];
    if (
      configured?.command !== "node" ||
      configured.args?.length !== 1 ||
      configured.args[0].replaceAll("\\", "/").replace(/^\.\//, "") !==
        server.entrypoint
    ) {
      throw new Error(`Catalog entry '${server.id}' does not match .mcp.json.`);
    }
    const packageDir = server.entrypoint.split("/").slice(0, 2).join("/");
    const packageJson = readJson(
      join(repoRoot, ...packageDir.split("/"), "package.json"),
    );
    if (
      packageJson.name !== server.package ||
      packageJson.version !== server.packageVersion
    ) {
      throw new Error(`Catalog package metadata for '${server.id}' is stale.`);
    }
  }
  const configuredIds = Object.keys(mcp.mcpServers ?? {});
  if (
    configuredIds.some((id) => !ids.has(id)) ||
    ids.size !== configuredIds.length
  ) {
    throw new Error(
      "Release catalog and .mcp.json contain different server IDs.",
    );
  }
  return catalog;
}

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
    const publicPath = join(source, "public");
    if (existsSync(publicPath))
      cpSync(publicPath, join(target, "public"), { recursive: true });
  }
}

export function writeLaunchers(
  bundleRoot,
  catalog,
  platform = process.platform,
) {
  const binDir = join(bundleRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const server of catalog.servers) {
    const packageRelative = runtimeEntrypoint(server);
    if (platform === "win32") {
      const entrypoint = packageRelative.replaceAll("/", "\\");
      const content = `@echo off\r\nif not "%RAVEN_RELEASE_LAUNCHER_CHECK%"=="1" goto run\r\n"%~dp0..\\runtime\\node.exe" --check "%~dp0..\\runtime\\${entrypoint}"\r\nexit /b %ERRORLEVEL%\r\n:run\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\runtime\\${entrypoint}" %*\r\n`;
      writeFileSync(join(binDir, `${server.launcher}.cmd`), content, "utf8");
    } else {
      const content = `#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nif [ "\${RAVEN_RELEASE_LAUNCHER_CHECK:-}" = "1" ]; then\n  exec "$SCRIPT_DIR/../runtime/node" --check "$SCRIPT_DIR/../runtime/${packageRelative}"\nfi\nexec "$SCRIPT_DIR/../runtime/node" "$SCRIPT_DIR/../runtime/${packageRelative}" "$@"\n`;
      const path = join(binDir, server.launcher);
      writeFileSync(path, content, "utf8");
      chmodSync(path, 0o755);
    }
  }
}

export function runtimeEntrypoint(server) {
  const [, , ...entrypointParts] = server.entrypoint.split("/");
  if (entrypointParts.length === 0) {
    throw new Error(`Invalid catalog entrypoint for '${server.id}'.`);
  }
  return [
    "node_modules",
    ...server.package.split("/"),
    ...entrypointParts,
  ].join("/");
}

function validateLauncher(bundleRoot, server) {
  const launcher = join(
    bundleRoot,
    "bin",
    `${server.launcher}${process.platform === "win32" ? ".cmd" : ""}`,
  );
  const command =
    process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : launcher;
  const args = process.platform === "win32" ? ["/d", "/c", launcher] : [];
  const result = spawnSync(command, args, {
    cwd: bundleRoot,
    env: { ...process.env, RAVEN_RELEASE_LAUNCHER_CHECK: "1" },
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${server.id} launcher failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

export async function smokeTest(bundleRoot, catalog, timeoutMs = 1500) {
  const executable = join(
    bundleRoot,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  for (const server of catalog.servers) {
    validateLauncher(bundleRoot, server);
    const entrypoint = join(bundleRoot, "runtime", runtimeEntrypoint(server));
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [entrypoint], {
        cwd: bundleRoot,
        env: { ...process.env, RAVEN_RELEASE_SMOKE_TEST: "1" },
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
              `${server.id} exited during smoke test (${code ?? signal}): ${output.trim()}`,
            ),
          );
      });
      setTimeout(() => {
        expectedStop = true;
        child.kill();
      }, timeoutMs);
    });
  }
}

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

export function resetDirectory(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}
