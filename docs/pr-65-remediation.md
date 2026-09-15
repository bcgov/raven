# PR #65 follow-up fixes

## Scope and revision

These changes follow the review of PR #65 at
`6557f38b329325cf4e002de61f5c367332f97019` (base `fd982f6`). They address the
seven code findings and two documentation findings from that review, plus
the confirmed successful-log privacy gap. They do not constitute a live
deployment or a fresh SonarQube scan.

## Changes and regression evidence

| Review finding | Change | Regression evidence |
| --- | --- | --- |
| 1. `uniq` output operands | Parse short options and numeric values; count stdin `-`; honor `--`; allow only one final input. | `packages/imis-mcp/src/__tests__/ssh-executor.test.ts`: both original overwrite commands are rejected and temporary output sentinels remain unchanged. Accepted separated options and quoted dash-prefixed input execute correctly. |
| 2. Credential regex complexity | Start scanning at a literal credential key; skip complete consumed values. | `packages/auth/src/__tests__/pi-scrubber.test.ts`: 80,000 quote/backslash nonmatches, previously about four seconds each, complete within the generous one-second regression budget. Final local measurements were about 2.24/0.69 milliseconds and scaled linearly through 320,000 characters. |
| 3. Encoded credential suffixes | Decode complete JSON string wrappers, then consume complete scalar values using their quoting context. | The scrubber suite compares exact output through nested JSON encodings, including whitespace, escaped double quotes/apostrophes and trailing backslashes. It checks preserved sibling fields, not only presence of `[CREDENTIAL]`. An additional 20,000 generated single-/double-quoted fixtures passed across zero to four JSON encodings. |
| 4. Expansion after validation | Record unquoted glob characters during tokenization and reject them for commands with argument policies. | IMIS tests cover mixed quoted/unquoted wildcard fragments, a matching `-o` filename, and quoted literal find patterns. |
| 5. Positional `date` setters | Permit only short display options with their values and an optional final `+FORMAT`. | Numeric clock-setting forms are rejected without executing them; display inputs and optional attached `-I` precision are accepted. |
| 6. Pinned SSH key negotiation | Prefer trusted key types by reordering the installed library's enabled algorithms. | `scripts/ssh-host-key.test.mjs`: both real connection builders connect to a multi-key loopback server with RSA alone pinned; mismatched, revoked, absent, malformed and CA-only trust still fail. |
| 7. Lost JSON diagnostics | Consume structured scalar values independently of length, stopping at their proper delimiter. | Exact-output cases for empty/short/null/boolean/numeric credentials, consecutive credentials and multiline JSON. Empty raw assignments preserve the following log line. |
| 8. Incorrect runtime support | Correct the audit, architecture checklist and executive stack summary. | `.github/workflows/ci.yml:34` selects Node 20. The official Node.js schedule records Node 20 EOL on 2026-04-30, Node 25 EOL on 2026-06-01 and Node 22 in Maintenance LTS. Runtime migration remains outstanding. |
| 9. Mislabelled coverage | Mark coverage as unmeasured test-coverage data; distinguish Sonar's reported zero from assessment coverage in HTML and JSON metadata. | Parsed `docs/report-data.json` and inspected the rendered “Test coverage data / Not measured” section. |
| Successful log privacy | Scrub successful application/httpd log results at the MCP response boundary. | `packages/server-mcp/src/__tests__/server.test.ts`: both in-memory MCP clients originally received the synthetic email/password; now receive only redacted output. |

Implementation locations at this revision: `packages/imis-mcp/src/ssh-executor.ts:144`
(`uniq`), `:166` (`date`), `:236` (tokenizer), `:290` (glob guard);
`packages/auth/src/pi-scrubber.ts:106` (JSON string decoding) and `:146` (credential scanner);
`packages/auth/src/known-hosts.ts:186` (algorithm ordering);
`packages/server-mcp/src/server.ts:157` and `:233` (successful log responses).

## Compatibility choices

- `uniq` accepts supported short options before its final input. Long options
  and options after an input are rejected. This remains safe when GNU's
  `POSIXLY_CORRECT` changes option parsing.
- Commands with argument policies reject unquoted wildcards, including
  absolute `sort`/`file` globs. Quote find predicates, e.g.
  `find /tmp -name '*.log'`. Quoting a filename wildcard makes it literal;
  ordinary `ls` and `grep` wildcard expansion remains supported.
- `date` accepts `-u`, `-R`, `-I`, `-d`, `-f`, `-r`, their supported attached
  or separated values, and a final `+FORMAT`.
- SSH ordering reads `ssh2/lib/protocol/constants.js` because ssh2's public
  API does not expose enabled defaults. Both integrations are tested against
  the installed version. The helper reorders that list; it does not enable
  an algorithm that the library disabled.
- Credential matching handles scalar values. Structured object/array
  credential values and escaped key-name characters are outside this change.
  Unchanged JSON string wrappers retain their original bytes; wrappers changed
  by redaction preserve diagnostic content but use canonical JSON escaping.
  The pre-existing email/IDIR regex performance findings remain separate.

## Verification

Final local verification on 2026-09-15 for these follow-up changes based on
`6557f38`:

| Check | Result |
| --- | --- |
| Dependency installation | Passed with lifecycle scripts disabled |
| Workspace TypeScript build | Passed |
| Full test suite | **1,382 passed, 1 skipped, 0 failed**; 75 files passed, 1 skipped |
| Tool inventory | Passed; `TOOL_INVENTORY.md` is up to date |
| Diff whitespace validation | Passed |
| Report data and rendered HTML | JSON parsed; corrected coverage section inspected in Chromium |
| PR head recheck | Remote still `6557f38b329325cf4e002de61f5c367332f97019` after validation |

Reproduction commands:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
node scripts/gen-inventory.mjs --check
git diff --check
```

The tests use generated temporary files, synthetic credentials and loopback
SSH servers. They do not modify application servers, system time, operator
credentials or real known-hosts files. Local execution used Node 25.9.0; that
EOL runtime is recorded as a limitation, not as supported-runtime validation.

## Remaining decisions and historical artifacts

- SMTP certificate verification is enabled by default, but STARTTLS remains
  optional outside port 465. Requiring it would reject plaintext-only relays;
  that compatibility decision is outstanding.
- Runtime migration remains outstanding. A Crow Sonar scan of `58c8486` on
  2026-09-15 completed with a failed quality gate (analysis
  `a67d01d1-21c9-4765-ba74-83c288afecfc`): 16 new-period code-quality issues,
  unreviewed hotspots, reliability rating C and absent measured coverage.
  It predates the follow-up below and is not a passing scan of that change.
- `docs/architecture.md`, `docs/report-data.json` and the executive HTML are
  labelled as historical assessments. Their old finding counts are not a
  current-head security score.
- The Crow renderer is maintained outside this repository. On regeneration,
  preserve `coverage_metric`, `coverage_measured` and `coverage_note` from
  `report-data.json`; do not turn missing test instrumentation into “0% entry
  points assessed.” The corrected HTML and data metadata are included here.


## Copilot follow-up at `58c8486`

The 2026-09-15 review published two inline comments and three suppressed
comments. The suppressed domain/app/component comments repeat the inline
newline finding; the suppressed country-code phone comment is independently
actionable.

| Comment or self-review finding | Disposition | Evidence |
| --- | --- | --- |
| Capitalized attribution phrases leave uppercase IDIRs visible | Fixed | Phrase matching ignores case; a separate uppercase-only candidate check preserves the existing length/stoplist contract. Tests include `Assigned to JSMITH`, `OWNER: MSMITH`, mixed/lowercase tokens, and overlapping attribution phrases. |
| `12505551234` / `+12505551234` are not scrubbed | Fixed | Optional country code is consumed with the number. Regression cases preserve longer identifiers, punctuation and NANP area/exchange constraints. |
| Self-review: serialized domain-qualified IDIR values leak | Fixed | The separator accepts JSON-escaped backslash runs. Tests compare exact output for raw values and four JSON wrapper layers, preserving diagnostic siblings. |
| Trailing line terminators bypass date/domain/app/component validators | False positive; regression coverage added | All relevant regexes omit `m`. Actual builders, MCP calls and HTTP query decoding reject LF, CR, CRLF, U+2028, U+2029 and NUL before remote work. Valid date/sentinel and identifier controls still pass. |
| Self-review: `jstat -J...` bypasses the read-only command policy | Fixed | An accepted local `jstat -J-Xlog:gc:file=<scratch>/proof.log -help` created a scratch file on Temurin 21. The policy now rejects JVM forwarding, including quoted fragments and unquoted wildcard expansion, while retaining normal jstat queries. No Java agent or remote host was used for this proof. |

The newline disposition follows [ECMAScript CompileAssertion, `$`](https://tc39.es/ecma262/2024/multipage/text-processing.html#sec-compileassertion):
line-terminator matching requires the multiline flag. Without it, the assertion
requires the end of the input. The production validators were not changed to
accommodate an incorrect finding. Shell comments were corrected separately:
a newline inside a single-quoted argument remains literal; an unquoted LF can
separate shell statements.

Regression locations:

- `packages/auth/src/__tests__/pi-scrubber.test.ts`
- `packages/imis-mcp/src/__tests__/ssh-executor.test.ts`
- `packages/server-mcp/src/__tests__/commands/log-search.test.ts`
- `packages/server-mcp/src/__tests__/server.test.ts`
- `packages/server-ui/__tests__/log-input-boundaries.test.ts`

Validation for this follow-up on 2026-09-15:

- Workspace TypeScript build: passed.
- Full suite: **1,495 passed, 1 skipped, 0 failed** across 76 passing test files.
- Tool inventory and `git diff --check`: passed.
- No application server, real credential or system clock was modified.
- Local Node runtime: 25.9.0; CI remains the separate Node 20 check.

## Copilot follow-up at `3d4229a`

The [2026-09-15 review](https://github.com/bcgov/raven/pull/65#pullrequestreview-5213900723)
identified one actionable finding: an accepted local settings request could
persist shell syntax in a base path, which a later SSH command interpolated.
The local request guard is still required, but does not make configuration
values safe for the file format or shell.

The fix validates the complete settings batch at the writer boundary before
replacing `servers.conf` or refreshing its cache. Non-string field values
(except unset base paths), embedded separators and control characters are
rejected before trimming. Base
paths must be absolute and contain only ASCII letters, digits, dots,
underscores, hyphens and slashes, with no `.` or `..` path segments. Invalid
requests return HTTP 400; they leave the existing file and cache unchanged.

Self-review traced the same values through discovery, version checks,
dashboards, configuration reads, log searches and downloads. Both buffered
and streaming SSH now reject unsafe configured base paths before accessing
credentials or connecting. Existing configurations remain readable so
operators can repair rejected paths. Direct MCP application/component inputs
are also checked where command paths are built; optional application filters
are quoted as literal arguments in their existing exact-match comparisons.

Compatibility retained: raw IPv6 hosts, username case, empty sudo accounts,
Unicode descriptions, default base paths, `/`, trailing path slashes, and
application/component names beginning with `_` or `-`. Log search uses the
same identifier guard as the other command builders.
Normalized paths containing whitespace or shell syntax must be corrected before use;
they are not silently rewritten. No host, service account or application
server was changed while reproducing these findings.

Regression evidence:

- `packages/server-ui/__tests__/server-config-write.test.ts`: guarded HTTP
  writes and direct writer calls reject invalid data without changing the
  file/cache; legacy rows remain GET-visible, no-sudo saves work through the
  frontend code, and actual filesystem failures remain HTTP 500.
- `packages/server-mcp/src/__tests__/ssh-config-validation.test.ts`: both
  transports reject unsafe base paths before credential access or connection
  construction; valid paths proceed to the ordinary authentication checks.
- `packages/server-mcp/src/__tests__/commands/input-boundaries.test.ts`:
  invalid paths/identifiers fail before execution; harmless local shell
  comparisons prove filters are literal and retain exact-match behavior.
- `packages/server-mcp/src/__tests__/command-inputs.test.ts`: actual MCP
  requests exercise these protections independently of dashboard validation.
- `packages/auth/src/__tests__/shell.test.ts`: shared path and identifier
  grammar, including positive compatibility controls.

Validation on 2026-09-15: workspace TypeScript build passed; **1,735 tests
passed, 1 skipped, 0 failed** across 81 passing test files; tool inventory
and diff whitespace checks passed. The previous Sonar analysis remains
separate and does not cover this follow-up.
