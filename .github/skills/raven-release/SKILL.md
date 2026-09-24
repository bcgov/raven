---
name: raven-release
description: Prepare and validate signed, platform-bundled Raven suite releases and manage their approval-gated GitHub draft workflow.
---

# Raven Release

Use this skill when planning, preparing, validating, packaging, or releasing
Raven.

## Context-efficient loading

1. Read [`modules/release-contract.md`](modules/release-contract.md) and
   [`modules/versioning.md`](modules/versioning.md) for every release task.
2. Read [`../../../release/server-catalog.json`](../../../release/server-catalog.json)
   when a server, entrypoint, platform, Node version, or package version changes.
3. Read only the release notes for the target version and the complete diff
   since the latest tag.

## Workflow

1. Classify the complete release diff and select one suite version using
   [`modules/versioning.md`](modules/versioning.md).
2. Update `package.json`, every workspace `package.json`, `package-lock.json`,
   `release/server-catalog.json`, README examples, and the target release notes
   together.
3. Run `npm ci`, `npm run build`, `npm test`, and
   `node scripts/gen-inventory.mjs --check`.
4. Generate an SPDX SBOM, prune development dependencies, run
   `npm run release:bundle -- --sbom <path> --output build/release`, and inspect
   the resulting archive.
5. Run `npm run release:verify -- --directory <aggregate-directory>` when all
   supported platform artifacts are present. During local development, add
   `--platform <current-platform>` to validate one locally built bundle.
6. Merge through normal review. A successful `CI` run on `main` starts
   `.github/workflows/release-draft.yml`; the protected `release` environment
   gates annotated-tag and draft-release creation.
7. Verify downloaded artifacts with both the SHA-256 value in their manifest
   and `gh attestation verify <archive> --repo bcgov/raven`.

Do not reconstruct packaging or release commands manually when the deterministic
scripts own the operation.

## Completion gate

- The version classification and any major-version decision comply with
  [`modules/versioning.md`](modules/versioning.md).
- Catalog, manifests, package versions, tag, and release notes agree.
- Every supported platform has one archive, manifest, SPDX SBOM, passing smoke
  tests, and GitHub attestations.
- Release creation is duplicate-safe and stops at a draft.
