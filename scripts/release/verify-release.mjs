#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  catalogPath,
  readJson,
  releasedEntries,
  sha256,
  validateCatalog,
} from "./release-lib.mjs";

const directoryFlag = process.argv.indexOf("--directory");
const directory = resolve(
  directoryFlag >= 0 ? process.argv[directoryFlag + 1] : "build/release",
);
const commitFlag = process.argv.indexOf("--commit");
const expectedCommit =
  commitFlag >= 0 ? process.argv[commitFlag + 1]?.toLowerCase() : undefined;
if (expectedCommit && !/^[0-9a-f]{40}$/.test(expectedCommit)) {
  throw new Error("--commit must be a full source commit SHA.");
}
if (!existsSync(directory))
  throw new Error(`Release directory does not exist: ${directory}`);

const catalog = validateCatalog();
const platformFlag = process.argv.indexOf("--platform");
const requestedPlatform =
  platformFlag >= 0 ? process.argv[platformFlag + 1] : undefined;
if (
  requestedPlatform &&
  !catalog.supportedPlatforms.includes(requestedPlatform)
) {
  throw new Error(`Unsupported release platform '${requestedPlatform}'.`);
}
const expectedPlatforms = requestedPlatform
  ? [requestedPlatform]
  : catalog.supportedPlatforms;
const manifests = readdirSync(directory)
  .filter((name) => name.endsWith(".manifest.json"))
  .map((name) => readJson(join(directory, name)))
  .filter(
    (manifest) => !requestedPlatform || manifest.platform === requestedPlatform,
  );
const platforms = new Set(manifests.map((manifest) => manifest.platform));
const referencedAssets = new Set();
if (
  manifests.length !== expectedPlatforms.length ||
  expectedPlatforms.some((platform) => !platforms.has(platform))
) {
  throw new Error(`Expected manifests for ${expectedPlatforms.join(", ")}.`);
}

for (const manifest of manifests) {
  const bundleName = `raven-${catalog.suiteVersion}-${manifest.platform}`;
  if (
    manifest.archive !== `${bundleName}.tar.gz` ||
    manifest.sbom !== `${bundleName}.sbom.spdx.json`
  ) {
    throw new Error(
      `Manifest for '${manifest.platform}' uses non-canonical artifact names.`,
    );
  }
  if (
    referencedAssets.has(manifest.archive) ||
    referencedAssets.has(manifest.sbom)
  ) {
    throw new Error(`Release artifacts are reused across platform manifests.`);
  }
  referencedAssets.add(manifest.archive);
  referencedAssets.add(manifest.sbom);
  if (
    manifest.suiteVersion !== catalog.suiteVersion ||
    manifest.nodeVersion !== catalog.nodeVersion ||
    (expectedCommit && manifest.sourceCommit !== expectedCommit) ||
    manifest.smokeTests?.status !== "passed" ||
    manifest.smokeTests?.validatedLauncherCount !==
      releasedEntries(catalog).length ||
    manifest.smokeTests?.startedServerCount !== catalog.servers.length
  ) {
    throw new Error(
      `Manifest for '${manifest.platform}' has inconsistent release metadata.`,
    );
  }
  const archivePath = join(directory, basename(manifest.archive));
  const sbomPath = join(directory, basename(manifest.sbom));
  if (
    !existsSync(archivePath) ||
    sha256(archivePath) !== manifest.archiveSha256
  ) {
    throw new Error(`Archive digest mismatch for '${manifest.platform}'.`);
  }
  if (!existsSync(sbomPath) || sha256(sbomPath) !== manifest.sbomSha256) {
    throw new Error(`SBOM digest mismatch for '${manifest.platform}'.`);
  }
  const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  if (!sbom.spdxVersion || !Array.isArray(sbom.packages)) {
    throw new Error(`SBOM for '${manifest.platform}' is not valid SPDX JSON.`);
  }

  if (manifest.catalogSha256 !== sha256(catalogPath)) {
    throw new Error(`Catalog digest mismatch for '${manifest.platform}'.`);
  }
  const archiveEntries = spawnSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
  if (archiveEntries.error || archiveEntries.status !== 0) {
    throw new Error(
      `Could not inspect '${manifest.archive}': ${archiveEntries.error?.message ?? archiveEntries.stderr.trim()}`,
    );
  }
  const entries = archiveEntries.stdout.trim().split(/\r?\n/);
  if (
    entries.some(
      (entry) =>
        entry.startsWith("/") ||
        /^[A-Za-z]:/.test(entry) ||
        entry.split("/").includes(".."),
    )
  ) {
    throw new Error(`Archive '${manifest.archive}' contains an unsafe path.`);
  }
  const extractionRoot = mkdtempSync(join(tmpdir(), "raven-release-verify-"));
  try {
    const extraction = spawnSync(
      "tar",
      ["-xzf", archivePath, "-C", extractionRoot],
      { encoding: "utf8", shell: false },
    );
    if (extraction.error || extraction.status !== 0) {
      throw new Error(
        `Could not extract '${manifest.archive}': ${extraction.error?.message ?? extraction.stderr.trim()}`,
      );
    }
    const embeddedRoot = join(extractionRoot, bundleName);
    const embeddedCatalog = join(embeddedRoot, "server-catalog.json");
    const embeddedMetadata = readJson(
      join(embeddedRoot, "bundle-metadata.json"),
    );
    const embeddedSbom = join(embeddedRoot, basename(manifest.sbom));
    if (
      !existsSync(join(embeddedRoot, "NODE_LICENSE")) ||
      embeddedMetadata.sbom !== manifest.sbom ||
      !existsSync(embeddedSbom) ||
      sha256(embeddedSbom) !== manifest.sbomSha256 ||
      sha256(embeddedCatalog) !== manifest.catalogSha256 ||
      embeddedMetadata.sourceCommit !== manifest.sourceCommit ||
      embeddedMetadata.platform !== manifest.platform ||
      embeddedMetadata.suiteVersion !== manifest.suiteVersion ||
      embeddedMetadata.nodeVersion !== manifest.nodeVersion ||
      embeddedMetadata.smokeTests?.status !== "passed"
    ) {
      throw new Error(
        `Embedded metadata for '${manifest.platform}' is inconsistent.`,
      );
    }
    const embeddedSbomDocument = readJson(embeddedSbom);
    if (
      !embeddedSbomDocument.spdxVersion ||
      !Array.isArray(embeddedSbomDocument.packages)
    ) {
      throw new Error(
        `Embedded SBOM for '${manifest.platform}' is not valid SPDX JSON.`,
      );
    }
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}
console.log(
  `Verified Raven ${catalog.suiteVersion} artifacts for ${[...platforms].sort().join(", ")}.`,
);
