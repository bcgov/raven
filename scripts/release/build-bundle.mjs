#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  catalogPath,
  copyProductionModules,
  copyWorkspacePackages,
  createArchive,
  findNodeLicense,
  git,
  readJson,
  repoRoot,
  resetDirectory,
  sha256,
  smokeTest,
  validateCatalog,
  writeLaunchers,
} from "./release-lib.mjs";

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error(`Invalid argument near '${key ?? ""}'.`);
    result[key.slice(2)] = value;
  }
  return result;
}

const options = args(process.argv.slice(2));
const outputDir = resolve(options.output ?? join(repoRoot, "build", "release"));
const sbomSource = resolve(
  options.sbom ?? join(repoRoot, "build", "sbom.spdx.json"),
);
const catalog = validateCatalog();
const platform = `${process.platform}-${process.arch}`;
if (!catalog.supportedPlatforms.includes(platform)) {
  throw new Error(`Unsupported release platform '${platform}'.`);
}
if (process.versions.node !== catalog.nodeVersion) {
  throw new Error(
    `Bundle requires Node.js ${catalog.nodeVersion}; found ${process.versions.node}.`,
  );
}
if (!existsSync(sbomSource)) throw new Error(`SBOM is missing: ${sbomSource}`);

const sourceCommit = git("rev-parse", "HEAD").toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit))
  throw new Error("Could not resolve the source commit.");
const bundleName = `raven-${catalog.suiteVersion}-${platform}`;
const bundleRoot = join(outputDir, bundleName);
const runtimeDir = join(bundleRoot, "runtime");
resetDirectory(bundleRoot);
mkdirSync(runtimeDir, { recursive: true });

cpSync(
  process.execPath,
  join(runtimeDir, process.platform === "win32" ? "node.exe" : "node"),
);
cpSync(findNodeLicense(), join(bundleRoot, "NODE_LICENSE"));
copyProductionModules(
  join(repoRoot, "node_modules"),
  join(runtimeDir, "node_modules"),
);
copyWorkspacePackages(join(runtimeDir, "node_modules"));
writeLaunchers(bundleRoot, catalog);

cpSync(join(repoRoot, "LICENSE"), join(bundleRoot, "LICENSE"));
cpSync(join(repoRoot, "README.md"), join(bundleRoot, "README.md"));
cpSync(join(repoRoot, ".env.example"), join(bundleRoot, ".env.example"));
cpSync(catalogPath, join(bundleRoot, "server-catalog.json"));
const sbomName = `${bundleName}.sbom.spdx.json`;
cpSync(sbomSource, join(bundleRoot, sbomName));

const bundleMetadata = {
  schemaVersion: 1,
  suiteVersion: catalog.suiteVersion,
  sourceRepository: "https://github.com/bcgov/raven",
  sourceCommit,
  platform,
  nodeVersion: process.versions.node,
  protocolCompatibility: catalog.protocolCompatibility,
  catalog: "server-catalog.json",
  sbom: sbomName,
  smokeTests: {
    launcherCount: catalog.servers.length,
    status: "pending",
  },
};
const metadataPath = join(bundleRoot, "bundle-metadata.json");
writeFileSync(
  metadataPath,
  `${JSON.stringify(bundleMetadata, null, 2)}\n`,
  "utf8",
);

await smokeTest(bundleRoot, catalog);
bundleMetadata.smokeTests.status = "passed";
writeFileSync(
  metadataPath,
  `${JSON.stringify(bundleMetadata, null, 2)}\n`,
  "utf8",
);

mkdirSync(outputDir, { recursive: true });
const archivePath = join(outputDir, `${bundleName}.tar.gz`);
createArchive(bundleRoot, archivePath);
const standaloneSbomPath = join(outputDir, sbomName);
cpSync(sbomSource, standaloneSbomPath);
const manifest = {
  ...bundleMetadata,
  archive: basename(archivePath),
  archiveSha256: sha256(archivePath),
  sbom: basename(standaloneSbomPath),
  sbomSha256: sha256(standaloneSbomPath),
  catalogSha256: sha256(catalogPath),
  provenanceVerification: `gh attestation verify ${basename(archivePath)} --repo bcgov/raven`,
};
const manifestPath = join(outputDir, `${bundleName}.manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    { bundleRoot, archivePath, manifestPath, sbomPath: standaloneSbomPath },
    null,
    2,
  ),
);
