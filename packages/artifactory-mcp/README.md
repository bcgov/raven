# RAVEN Artifactory MCP

Generic JFrog Artifactory tools for Raven. The implementation is verified against the NRS instance running Artifactory `6.23.7` and uses REST endpoints available in that release.

## Configuration

Set dedicated credentials in `~/.raven/.env`:

```env
ARTIFACTORY_URL=<internal Artifactory HTTPS base URL>
ARTIFACTORY_EMAIL=<your gov.bc.ca email>
ARTIFACTORY_PASSWORD=<your IDIR password>
```

Ask the RAVEN maintainer or your team lead for the internal Artifactory URL. `ARTIFACTORY_URL` must use HTTPS. The server does not implicitly reuse `ATLASSIAN_*` credentials, accept raw credentials through MCP arguments, follow authentication redirects, or include upstream error bodies in model-visible errors.

On Windows, `scripts/setup-credentials.ps1` stores `ARTIFACTORY_URL`, `ARTIFACTORY_EMAIL`, and `ARTIFACTORY_PASSWORD` in Raven's DPAPI-encrypted credential file.

Optional transfer controls:

```env
RAVEN_ARTIFACTORY_UPLOAD_DIR=~/.raven/artifactory-uploads
RAVEN_ARTIFACTORY_DOWNLOAD_DIR=~/.raven/artifactory-downloads
RAVEN_ARTIFACTORY_MAX_TRANSFER_BYTES=536870912
RAVEN_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS=1800000
# Comma-separated exact HTTPS hostnames approved for direct cloud-storage downloads.
RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS=storage.example.gov.bc.ca
```

Transfer directories must be accessible only to the owner (`chmod 700`). Upload sources must be regular, non-symlink files with mode `600`. Paths are relative to their configured roots. Downloads have a 30-minute default timeout, configurable up to 24 hours through `RAVEN_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS`. Direct-download redirects remain disabled unless their exact storage hostname is allowlisted. External storage requests never receive Artifactory credentials.

The repositories visible during validation against the NRS Artifactory `6.23.7` instance all reported `downloadRedirect=false`; the allowlist supports a future cloud-storage-backed repository without weakening the default redirect policy.

## Tools

Read operations cover service/version discovery, repositories, item metadata, folder listings, properties, statistics, artifact-name search, bounded structured AQL item search, build names, build runs, and build-info.

Guarded operations cover:

- Downloads stream into an exclusive temporary file beneath the protected download root, compute SHA-1 and SHA-256 incrementally, and install the file only after matching Artifactory metadata. Existing destinations are preserved if transfer or verification fails. Download overwrite is disabled on Windows to avoid reparse-point races.
- Uploads use replayable file-backed streams from the protected upload root and compute SHA-1 and SHA-256 incrementally before sending the artifact. Existing Artifactory destinations are refused unless `overwrite=true`.
- Copy and move operations that default to dry-run; live execution requires an exact path confirmation.
- File deletion requiring an exact path confirmation and the current server-provided SHA-256. Folder deletion is refused.
- Property set/delete operations with recursion disabled by default and an exact path confirmation.

Repository configuration, user management, permission management, token management, plugin execution, arbitrary AQL, and arbitrary HTTP requests are not exposed.
