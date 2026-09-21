# Raven Packaging and Releases

Raven uses one SemVer suite release with signed, platform-specific bundled
runtimes. This contract is designed for the Crow Raven Setup Agent introduced
in [bcgov/crow#31](https://github.com/bcgov/crow/pull/31).

## Release assets

Each release contains three assets for every supported platform:

1. `raven-<version>-<platform>.tar.gz` - Node.js runtime, production
   dependencies, compiled Raven packages, native launchers, catalog, SBOM, and
   Raven and Node.js licences, and documentation.
2. `raven-<version>-<platform>.manifest.json` - source commit, platform,
   runtime, catalog digest, archive digest, SBOM digest, and smoke-test result.
3. `raven-<version>-<platform>.sbom.spdx.json` - standalone SPDX SBOM.

The versioned catalog at [`release/server-catalog.json`](../release/server-catalog.json)
is validated against [`.mcp.json`](../.mcp.json) and every workspace package
during tests.

## Automated release flow

1. A pull request updates the suite version, catalog, and reviewed release
   notes together.
2. The normal `CI` workflow builds, tests, and validates the exact commit.
3. After that commit reaches `main`, the
   [`Raven release draft`](../.github/workflows/release-draft.yml) workflow
   builds Linux x64, Windows x64, and macOS x64 bundles independently.
4. Each clean hosted runner generates an SPDX SBOM, uses the bundled Node
   runtime to smoke-test every MCP entrypoint, and creates GitHub build and
   SBOM attestations.
5. The protected `release` environment requires maintainer approval.
6. The approved job verifies all platform manifests and digests, creates an
   annotated `v<version>` tag for the exact validated commit, and creates a
   GitHub draft release.
7. A maintainer reviews and publishes the draft separately.

Configure required reviewers on the `release` GitHub environment before
enabling the workflow. Enable GitHub immutable releases so assets and tags
cannot be changed after a maintainer publishes the reviewed draft.

## Consumer verification

Checksums detect corruption; signed provenance authenticates the GitHub
workflow and source repository:

```text
gh attestation verify raven-0.1.0-win32-x64.tar.gz --repo bcgov/raven
```

Compare the archive SHA-256 with its manifest before extraction. The manifest's
source commit and suite version must match the intended release.

## Transitional source build

Until Crow consumes the bundled runtime contract, it may clone an immutable
Raven commit into an isolated directory, use the exact supported Node version
and lockfile, run `npm ci`, and build locally after explicit confirmation.
This remains lower assurance because npm lifecycle and Raven build scripts run
on the consumer machine.

## Release management

Use the repository's **Raven Release Agent** or `raven-release` skill to prepare
and validate a release. Its routed versioning policy classifies compatible
changes as patch releases, new MCP servers as minor releases, and incompatible
contract changes as user-approved major releases.
