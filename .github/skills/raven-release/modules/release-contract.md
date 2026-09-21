# Raven Release Contract

## Delivery model

Raven publishes one SemVer suite release with a separate archive for each
supported platform. Each archive contains:

- the pinned Node.js runtime, so consumers do not need a system Node install;
- production dependencies and compiled Raven workspace packages;
- one native launcher per MCP server;
- the versioned server catalog, source commit, runtime version, and supported
  platform metadata;
- the platform SPDX SBOM; and
- licence, setup, and environment-template documentation.

The release also publishes each platform manifest and SBOM as standalone
assets. A manifest binds the archive and SBOM SHA-256 digests to the suite
version, source commit, runtime, platform, catalog digest, and smoke-test
result.

## Trust model

SHA-256 detects corruption but does not authenticate the publisher. The
main-branch workflow therefore creates GitHub build-provenance and SBOM
attestations with OIDC. Consumers must verify the downloaded archive with
`gh attestation verify` against `bcgov/raven` before installation.

The workflow is triggered only by a successful `CI` run for the exact `main`
commit. Platform jobs rebuild independently and smoke-test every MCP entrypoint
with the bundled runtime. A protected `release` environment gates the job that
revalidates the aggregate artifacts, creates an annotated tag, and creates a
GitHub draft release. Draft publication remains manual.

## Supported platforms

The initial contract covers `linux-x64`, `win32-x64`, and `darwin-x64` with
Node.js 24.21.0. A platform is supported only when its hosted clean runner
builds the bundle and every MCP entrypoint survives the startup smoke test.

Playwright browser binaries are not bundled. Interactive SiteMinder login
requires the documented Playwright browser installation; Basic Auth and cached
SiteMinder sessions do not.

## Transitional source builds

Crow may continue to install an immutable Raven commit with `npm ci` and an
exact supported Node runtime until it consumes this release contract. That path
has lower assurance because dependency lifecycle and Raven build scripts run
on the consumer machine. It must remain explicit, isolated, and recoverable.
