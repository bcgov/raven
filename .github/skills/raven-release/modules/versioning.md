# Raven Versioning Policy

Raven uses semantic versioning for the complete runtime suite.

## Version selection

| Change                                                                                                                                                                   | Version                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Compatible correction, dependency update, clarification, release automation, bugfix, documentation, compatible tool addition, or fix to an existing capability           | Patch                             |
| New MCP server                                                                                                                                                           | Minor                             |
| Incompatible rename, removal, installation change, invocation contract change, launcher or catalog contract change, supported-platform removal, or output contract break | Major, only when the user decides |

Use the highest classification present in the complete release diff. A new MCP
server remains minor even when it also updates existing servers, agents,
skills, documentation, or release automation. Security fixes are patch unless
they add a new MCP server or require an incompatible contract.

The candidate must be newer than the latest prior SemVer release. An existing
tag equal to the candidate is ignored only when retrying draft creation for
that same immutable release; older candidate versions are rejected.

## Major release control

Explain the incompatibility and ask the user whether to release a major
version. When the selected major version exceeds the latest release tag, record
the separate approval in `.github/release-major/v<version>.json`:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "approved": true
}
```

The version-specific file must be reviewed and committed. Both candidate
preparation and draft creation validate it independently. Neither prior release
history nor the apparent size of a change authorizes a major release.

## Release source of truth

The Raven suite version must agree across:

- the root `package.json`;
- every workspace `package.json`;
- `package-lock.json`;
- `release/server-catalog.json`;
- the release tag `v<version>`; and
- the reviewed release notes at `.github/release-notes/v<version>.md`.

Every server uses the suite version while Raven is released as one
compatibility unit. Use the deterministic catalog and release validators rather
than checking these references manually.

## Release safety

- Prepare version changes in reviewed source before publication.
- Publish only from the exact clean, CI-validated default-branch commit.
- A version is released at most once; never move or overwrite a release tag.
- Create an annotated tag before creating the GitHub draft release.
- Keep the release approval gate and final draft publication decision separate.
- Do not include research evidence, caches, internal links, credentials, or
  untracked files in release assets.
