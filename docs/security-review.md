---
document_type: security-review
assessment_date: 2026-09-14
application: "Resource Analytics, Visibility & Enterprise Navigator"
application_acronym: "RAVEN"
reviewed_ref: "origin/main @ fd982f6"
overall_risk: HIGH
remediation_status: "RSEC-001..007 fixed on security-remediation-2026-09-14; RSEC-008..013 open"
remediation_branch: "security-remediation-2026-09-14"
total_findings: 13
critical_count: 2
high_count: 2
medium_count: 3
low_count: 3
informational_count: 3
confirmed_count: 10
probable_count: 3
owasp_categories: [A01, A02, A04, A05]
cwe_ids: [CWE-78, CWE-88, CWE-79, CWE-284, CWE-295, CWE-352, CWE-359, CWE-522, CWE-918, CWE-1021]
asvs_requirements: [V4.1.1, V4.2.1, V5.3.3, V5.3.8, V6.2.1, V8.3.1, V9.2.1, V12.6.1, V14.4.1]
mitre_techniques: [T1059.004, T1190, T1557, T1552.001, T1189]
sonarqube_quality_gate: ERROR
sonarqube_branch: main
npm_audit_total: 0
sonar_sca_enabled: false
coverage_provider_installed: false
tech_stack: ["Node.js (engine >=20.16.0 <21 || >=22.3.0)", "TypeScript 7.0.2", "Express 5.2.1", "@modelcontextprotocol/sdk 1.30.0", "@github/copilot-sdk 1.0.11", "ssh2 1.17.0", "Playwright 1.62.1", "Vitest 4.1.11", "Zod 4.5.4"]
---

# Application Security & Dependency Review: RAVEN - Resource Analytics, Visibility & Enterprise Navigator

Security posture, framework currency, dependency audit, static analysis summary, and manual review findings for **Resource Analytics, Visibility & Enterprise Navigator (RAVEN)**.

**Reviewed ref: `origin/main` @ `fd982f6`.** Every version number, advisory count, scan metric, and source citation in this document was taken from that ref in a clean detached worktree. This matters: an earlier pass of this review was performed against a working tree nine commits stale and reached the wrong dependency conclusion. Pin the ref before auditing.

---

## Revision History

| Version | Date | Author | Changes |
| :--- | :--- | :--- | :--- |
| `1.0` | `2026-09-14` | `Crow Security & Dependency Review Agent (Claude Opus 5)` | `Initial review against origin/main @ fd982f6. Manual review with executable probes, codebase-memory call-graph tracing, npm audit, and a SonarQube scan of main.` |

---

## 0. Remediation Status

All seven Critical, High and Medium findings were remediated on branch
`security-remediation-2026-09-14`, branched from `fd982f6`. Verification:
clean `tsc --build`, full suite **1184 passed / 1 skipped / 0 failed**, and a
SonarQube scan of the branch returning quality gate **OK** with **28 hotspots —
identical to `main`, none in the new code**.

| Finding | Status | Fix |
| :--- | :--- | :--- |
| `RSEC-001` | **Fixed** | Grep pattern escaped per-argument via a shared helper and passed after `-e`; `date`/`dateFrom`/`dateTo` validated to `YYYY-MM-DD` in both builders and at the tool boundary; `|` still works as `grep -E` alternation |
| `RSEC-002` | **Fixed** | CR/LF rejected before the allowlist tokenizer sees them; per-command argument policy so an allowlisted binary cannot execute or write through its own options. The policy runs on the argv the remote shell builds, not on whitespace-split source text, and covers the four ways an option evaded it: short-option clusters (`sort -uo`), quote reassembly (`sort -'o'`), GNU long-option abbreviation (`date --s`), and glob expansion past a positional cap (`uniq *`) |
| `RSEC-003` | **Fixed** | `sanitizePath` rejects control and quote characters; output escaped at interpolation |
| `RSEC-004` | **Fixed** | Unseparated SIN (Luhn-gated), unseparated NANP phone, domain-qualified IDIR, and bare IDIR in attribution context (`assigned to JSMITH`, `owner: MSMITH` — 5-8 uppercase after an attribution phrase, common acronyms excluded); credential values matched to whitespace so quotes and punctuation cannot truncate the redaction; quoted key names redacted, so a JSON `"password": "..."` no longer passes through; credential minimum 16 → 8 |
| `RSEC-005` | **Fixed** | `localGuard` validates Host, Origin and `Sec-Fetch-Site` ahead of every API router — the last catches no-cors embeds that carry no Origin |
| `RSEC-006` | **Fixed** | `known_hosts` verification in **both** SSH clients, one shared implementation; `@revoked` enforced as an explicit deny and host fields treated as patterns |
| `RSEC-007` | **Fixed** | TLS validation on by default; `SMTP_INSECURE_TLS=true` to opt out |
| `RSEC-008` to `RSEC-013` | Open | Out of the agreed remediation scope (Low and Informational) |

The three duplicated `shellEscape` copies and both `hostVerifier` sites were
consolidated into `@nrs/auth`, which addresses the duplicated-security-logic
technical debt item as a side effect rather than leaving two copies to drift
again.

### Operator action required before merge

`RSEC-006` changes default behaviour. An unknown or mismatched SSH host key now
**fails the connection**. Before this branch is used against real servers, each
BC Gov application server must appear in `~/.ssh/known_hosts` — connect once
with the ordinary `ssh` client to record each key. `RAVEN_SSH_INSECURE_HOST_KEYS=true`
restores the previous accept-anything behaviour as a deliberate, logged
exception. A key *mismatch* deliberately does not suggest that flag.

---

## 1. Framework & Runtime Currency Audit

| Technology Category | Tech Stack Item | Version | Support / EOL Status |
| :--- | :--- | :--- | :--- |
| **Runtime** | Node.js (declared engine) | `>=20.16.0 <21 \|\| >=22.3.0` | Active — Node 22 is Active LTS. Note the declared range also admits Node 24/25; the review host ran v25.9.0, which is outside any LTS line |
| **Language** | TypeScript | `7.0.2` | Active. Repository is on `tsgo`; stale `.tsbuildinfo` from TS5 causes unreliable incremental builds |
| **Web framework** | Express | `5.2.1` | Active |
| **Protocol** | `@modelcontextprotocol/sdk` | `1.30.0` | Active |
| **Agent SDK** | `@github/copilot-sdk` | `1.0.11` | Active (1.0.13 available) |
| **SSH client** | `ssh2` | `1.17.0` | Active |
| **Browser automation** | `playwright` | `1.62.1` | Active (1.63.0 available) |
| **Schema validation** | `zod` | `4.5.4` | Active (4.6.5 available) |
| **Test framework** | `vitest` | `4.1.11` | Active |

No end-of-life runtime or framework is in use.

---

## 2. Third-Party Dependency & License Inventory

Versions read from `package-lock.json` at `fd982f6`. "Latest" confirmed by `npm outdated` executed in the worktree on 2026-09-14 — not mirrored from the lockfile.

| Dependency | Installed | Latest | License | Direct / Transitive | License Risk |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `@modelcontextprotocol/sdk` | `1.30.0` | `1.30.0` | MIT | Direct | Compliant |
| `@github/copilot-sdk` | `1.0.11` | `1.0.13` | MIT | Direct | Compliant |
| `express` | `5.2.1` | `5.2.1` | MIT | Direct | Compliant |
| `ssh2` | `1.17.0` | `1.17.0` | MIT | Direct | Compliant |
| `nodemailer` | `10.0.0` | `10.0.10` | MIT-0 | Direct | Compliant |
| `zod` | `4.5.4` | `4.6.5` | MIT | Direct | Compliant |
| `playwright` | `1.62.1` | `1.63.0` | Apache-2.0 | Direct | Compliant |
| `markdown-it` | `15.0.1` | `15.0.2` | MIT | Direct | Compliant |
| `sanitize-html` | `2.17.7` | `2.17.7` | MIT | Direct | Compliant |
| `mammoth` | `1.12.2` | `1.12.3` | BSD-2-Clause | Direct | Compliant |
| `pdf-parse` | `2.4.5` | `2.4.5` | Apache-2.0 | Direct | Compliant |
| `turndown` | `7.2.4` | `7.2.4` | MIT | Direct | Compliant |
| `dotenv` | `17.4.2` | `17.4.2` | BSD-2-Clause | Direct | Compliant |
| `cross-spawn` | `7.0.6` | `7.0.6` | MIT | Direct | Compliant |
| `stemmer` | `2.0.1` | `2.0.1` | MIT | Direct | Compliant |
| `typescript` | `7.0.2` | `7.0.2` | Apache-2.0 | Direct (dev) | Compliant |
| `vitest` | `4.1.11` | `5.0.0` | MIT | Direct (dev) | Compliant |
| `@types/node` | `26.4.0` | `26.5.1` | MIT | Direct (dev) | Compliant |
| `hono` | `4.13.7` | `4.13.7` | MIT | Transitive | Compliant |
| `qs` | `6.16.0` | `6.16.0` | BSD-3-Clause | Transitive | Compliant |
| `fast-uri` | `3.1.7` | `3.1.7` | BSD-3-Clause | Transitive | Compliant |
| `@xmldom/xmldom` | `0.8.15` | `0.8.15` | MIT | Transitive | Compliant |

All licenses are permissive. No copyleft or restrictive license is present. Drift from latest is minor-version only.

---

## 3. Known CVE & Vulnerability Assessment

| CVE / Advisory | Affected Component | Vulnerable Version | Severity | Fixed Version | Provenance | Remediation Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| *None open* | Not applicable | Not applicable | None | Not applicable | `[npm audit — verified]` | Patched / up to date |

```text
$ npm audit                     # origin/main @ fd982f6, installed tree
found 0 vulnerabilities
```

**Provenance note.** SonarQube SCA is **not enabled** on this server — every scan log for this project records `Dependency analysis skipped`. No dependency row in this document may therefore carry a `[SonarQube]` provenance tag. `npm audit` against the pinned lockfile is the evidence source, and per Crow's CVE provenance rules any dependency assessment not confirmed by a scanner would otherwise be `[AI-estimated]`.

**Remediation velocity is good.** Four advisory classes (nodemailer, hono, qs/xmldom/fast-uri) were published and closed by Dependabot between 2026-09-02 and 2026-09-11, merged as PRs #57–#64. This is the principal evidence supporting further automation of dependency updates.

---

## 4. SonarQube Code Analysis & Quality Gate Summary

### 4.1 Quality Gate Status

* **Quality gate:** `ERROR`
* **Project / branch:** `RAVEN` / `main`
* **Scan date:** `2026-09-14`
* **SCM revision:** `fd982f64a1c9dfd779ab858f1b3c112f27ab9087`
* **Source files analysed:** 202

| Failing condition | Threshold | Actual |
| :--- | :--- | :--- |
| `new_coverage` | ≥ 10 | `0.0` |
| `new_security_hotspots_reviewed` | 100% | `0.0` |
| `new_software_quality_reliability_rating` | ≤ 1 (A) | `4` (D) |
| `new_violations` | 0 | `240` |

**Read this gate failure carefully before escalating it.** The previous analysis of `main` was 2026-07-08, so the New Code period spans roughly two months of merged work in a single evaluation. The 240 "new" violations are the accumulated delta since July, not a sudden regression. The gate is nevertheless genuinely red, and the coverage and hotspot-review conditions are structural rather than incidental: coverage is `0.0` because no coverage provider is installed at all (`RSEC-012`), and hotspots reviewed is `0.0` because no one has triaged the hotspot queue.

### 4.2 Security & Quality Metrics

| Metric | Value | Notes |
| :--- | :--- | :--- |
| **Vulnerabilities** | `0` | Clean SAST vulnerability scan |
| **Bugs** | `13` | 9 unsafe `Array.prototype.sort`, 3 regex control character, 1 regex precedence |
| **Security hotspots** | `28` to review | 3 High, 8 Medium, 17 Low |
| **Coverage** | `0.0%` | No coverage provider installed — see `RSEC-012` |
| **Duplication** | Low | No duplication gate failure |

A scan-hygiene note that materially affects these numbers: the server's global `sonar.exclusions` already excludes `**/__tests__/**` and `**/*.test.ts`. A scan that passes its own `-Dsonar.exclusions` **replaces** that list rather than extending it, pulling every test file into the analysis and inflating hotspot and bug counts. The figures above come from a scan whose exclusion list re-includes the server defaults.

### 4.3 High Priority Issues / Hotspots

| Type | Severity | Location | Assessment |
| :--- | :--- | :--- | :--- |
| Hotspot | HIGH | `scripts/setup-credentials-mac.test.mjs:25,26,60` | Test fixture values in a `.mjs` file that the `**/*.test.ts` exclusion does not match. Not live secrets. Should be marked *Safe* in Sonar so genuine credential hotspots are not buried |
| Hotspot | MEDIUM | 8 sites — `artifactory-client.ts:60`, `github-client.ts:119`, `jenkins-client.ts:41`, `repo-clone.ts:115`, `detect.ts:214`, `plan-functional.ts:124`, `plan.ts:459`, `sharepoint-client.ts:78` | Super-linear regex backtracking. Several parse **remote** responses, so these warrant real review rather than bulk dismissal |
| Hotspot | LOW | 16 sites in `pipeline/` plus `spo-session-manager.ts:159` | `execFileSync` without absolute binary paths; PATH-resolution hotspots |
| Bug | CRITICAL | 9 sites incl. `auth/src/audit-log.ts:70,120` | `sort()` without a comparator — connects directly to the Unicode gap in the architecture document |
| Bug | MAJOR | `auth/src/content-blocks.ts:14` (×2), `server-ui/src/lib/parsers.ts:18` | Control characters in regular expressions |

---

## 5. Security Posture & Safeguards

| Security Domain | Findings / Controls | Compliance Rating |
| :--- | :--- | :--- |
| **Hardcoded secrets** | No live secret in source. Sample configs use placeholders; all High hotspots are test fixtures | `Pass` |
| **Authentication & token handling** | SiteMinder `SMSESSION` with ~25-minute TTL, cached at mode 0600, backed by macOS Keychain or Windows DPAPI. Server UI on `127.0.0.1:3777` has no authentication at all | `Needs Review` |
| **Input validation** | Zod schemas at every MCP tool boundary. Two shell-command builders use incomplete metacharacter denylists and are injectable | `Flagged` |
| **Cryptography** | SHA-256 hash chaining for tamper-evident audit logs; `crypto.randomBytes` for identifiers. SSH host key checking and SMTP TLS verification are unconditionally disabled | `Flagged` |
| **Audit & logging hygiene** | Hash-chained JSONL audit records with `verifyAuditFile` integrity walk, scrubbed by `PiScrubber` before write. Scrubber pattern coverage is incomplete | `Needs Review` |

### 5.1 Zero Trust and resource-protection controls

| Control | Status | Evidence / scope |
| :--- | :--- | :--- |
| Protected resources and access paths inventoried | `Pass` | 21 packages, 17 MCP servers, 15 Server UI routers, SSH targets — see §8 |
| Authorization enforced per resource and action, not only at sign-in | `Flagged` | `server-ui` enforces neither authentication nor authorization on any router (`RSEC-005`) |
| Access scope, duration, workload identity, least privilege explicit | `Pass` | Upstream calls carry the operator's own identity; sudo targets allowlisted to named service accounts |
| Expiry, revocation, rotation, replay handling defined and tested | `Needs Review` | Session TTL and `clearCachedSession` exist; no rotation schedule or provider-token revocation path |
| Exceptions time-bound, attributable, approved, reviewable | `Pass` | Hash-chained audit records under `~/.raven/audit/*.jsonl` |
| Dependency failure degrades safely without silent privilege expansion | `Pass` | All observed failure paths deny explicitly; no stale-data or downgraded-auth fallback |
| Telemetry privacy-preserving and sufficient to reconstruct decisions | `Needs Review` | `PiScrubber` is wired into the right paths but leaks unseparated identifiers (`RSEC-004`) |

### 5.2 Platform, data minimization, and proof controls

| Control | Status | Evidence / scope |
| :--- | :--- | :--- |
| Requests and responses minimized to stated purpose | `Pass` | Zod-bounded arguments, capped result sets (`maxResults`, `clampPerPage`) |
| Subject, tenant, audience, purpose scope enforced by provider | `Pass` | Upstream systems enforce the operator's own entitlements |
| Pairwise identifiers prevent cross-party correlation | `N/A` | Single-workstation tool; no cross-party identity exchange |
| Proof audience, expiry, revocation, replay resistance verified | `Pass` | SHA-256 chain with `GENESIS_HASH` verification |
| Assurance level and identity downgrade/fallback safe | `Pass` | No silent fallback to an unauthenticated session; failure prompts interactive re-login |
| Observable decisions retain privacy-preserving audit context | `Needs Review` | Scrubbed audit context present, subject to the scrubber gaps in `RSEC-004` |

---

## 6. OWASP Top 10 (2025) Analysis

### A01:2025 — Broken Access Control
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Missing or bypassable authorization | `Flagged` | `server-ui` exposes `GET/PUT /api/servers` and log download with no auth (`RSEC-005`) |
| Insecure direct object references | `Pass` | File access scoped by `logsBase` and validated server names |
| Path traversal | `Pass` | `APP_COMPONENT_RE` blocks `/` and `..`; `sanitizePath` rejects `..`; `assertInsideCloneBase` guards clones |
| Missing function-level access control | `Flagged` | Any local process or cross-origin page can reach the dashboard API |
| CORS misconfiguration | `Flagged` | No CORS, Origin, or Host validation on `127.0.0.1:3777` |
| Privilege escalation | `Flagged` | Shell injection escalates SSH user to `sudoUser` (`RSEC-001`, `RSEC-002`) |
| SSRF | `Flagged` | Webhook validation checks literal IPs only, never resolves DNS (`RSEC-010`) |

### A02:2025 — Security Misconfiguration
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Default credentials | `Pass` | Example files only; operator supplies real values |
| Verbose errors exposing internals | `Pass` | `safeErr` sanitizes and scrubs error text |
| Unnecessary features enabled | `Pass` | Background collector disabled at startup by default |
| Missing security headers | `Flagged` | No `helmet`, CSP, `X-Frame-Options`, or `X-Content-Type-Options` (`RSEC-011`) |
| Debug modes in production | `Pass` | Debug logging requires explicit `DEBUG` or `RAVEN_LOG_LEVEL` |

### A03:2025 — Software Supply Chain Failures
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Known vulnerable dependencies | `Pass` | `npm audit` reports 0 at `fd982f6` |
| Outdated frameworks | `Pass` | Minor drift only; no EOL component |
| Missing lockfile | `Pass` | `package-lock.json` committed with integrity hashes |
| Dependency confusion | `Pass` | Internal packages scoped `@nrs/` |
| Compromised or unpinned CI components | `Pass` | `ci.yml` pins actions and sets `permissions: contents: read` |
| Automated dependency surveillance | `Pass` | Dependabot active and closing advisories within days |

### A04:2025 — Cryptographic Failures
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Weak algorithms | `Pass` | SHA-256 for integrity; no MD5/SHA-1 in a security context |
| Hardcoded keys | `Pass` | None found |
| Insecure randomness | `Pass` | `crypto.randomBytes` |
| Missing TLS enforcement | `Flagged` | SMTP transport hardcodes `rejectUnauthorized: false` (`RSEC-007`) |
| Plaintext transmission of secrets | `Flagged` | SSH host key verification disabled at two sites (`RSEC-006`) |

### A05:2025 — Injection
| Check | Status | Evidence |
| :--- | :--- | :--- |
| SQL injection | `N/A` | No database |
| Command injection | `Flagged` | Two confirmed, reproduced sinks (`RSEC-001`, `RSEC-002`) |
| LDAP / XPath / template injection | `N/A` | Not used |

### A06:2025 — Insecure Design
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Missing security design patterns | `Pass` | Allowlisting, defense in depth, token bucket, circuit breaker |
| Threat modelling evidence | `Pass` | `docs/architecture.md` and `docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md` |
| Rate limiting | `Pass` | `TokenBucket` and `CircuitBreaker` in `@nrs/auth` |
| Duplicated security-critical logic | `Flagged` | Two independent SSH clients and two metacharacter denylists that have already drifted apart |

### A07:2025 — Authentication Failures
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Weak password policy | `N/A` | Delegated to enterprise SiteMinder / IDIR |
| Missing MFA | `Pass` | Inherits enterprise MFA via interactive browser login |
| Session fixation | `Pass` | `SMSESSION` lifecycle with ~25-minute TTL |
| JWT flaws | `N/A` | JWTs not used |

### A08:2025 — Software or Data Integrity Failures
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Insecure deserialization | `Pass` | `JSON.parse` only; no `eval` or unsafe deserializer |
| CI/CD pipeline injection | `Pass` | Least-privilege workflow on clean runners |
| Trust on first use | `Flagged` | SSH host keys accepted unconditionally (`RSEC-006`) |

### A09:2025 — Security Logging & Alerting Failures
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Missing security event logging | `Pass` | Audit log records tool invocations and state changes |
| Log integrity protection | `Pass` | SHA-256 chain, `verifyAuditFile` |
| Logs containing sensitive data | `Flagged` | `PiScrubber` misses unseparated SIN, phone, and bare IDIR (`RSEC-004`) |
| Logging without alerting | `Pass` | Email and SSE alerting in `server-ui` |

### A10:2025 — Mishandling of Exceptional Conditions
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Handlers exposing stack traces | `Pass` | `safeErr` strips and scrubs |
| Failing open on error | `Pass` | Failures deny by default |
| Swallowed exceptions | `Pass` | Errors surfaced to the caller and audit trail |

### OWASP Top 10 for LLM Applications
| Check | Status | Evidence |
| :--- | :--- | :--- |
| LLM01 direct prompt injection | `Pass` | Structured tool schemas; external text treated as data |
| LLM01 indirect / second-order injection | `Flagged` | Attacker-influenced ticket or log text can reach the shell sinks of `RSEC-001` / `RSEC-002` through an MCP tool argument — this is the realistic exploit path for both Criticals |
| LLM02 sensitive information disclosure | `Needs Review` | `PiScrubber` runs before model calls but leaks the identifier classes in `RSEC-004` |
| LLM05 model output reaching HTML without validation | `Flagged` | `markdownToHtml` catch block emits unescaped input (`RSEC-009`) |
| LLM06 excessive agency | `Pass` | Copilot SDK runs with `availableTools: []`; destructive git actions gated |
| LLM10 unbounded consumption | `Pass` | `aiTimeoutMs()` clamped 60s–600s; inputs sliced |

### Markdown and Documentation Security
| Check | Status | Evidence |
| :--- | :--- | :--- |
| Markdown pipelines inventoried | `Pass` | `markdown-it`, `turndown`, `mammoth`, `pdf-parse` |
| Raw HTML/script blocked in renderer | `Pass` | `markdown-it` configured `html: false` |
| Dangerous URL schemes restricted | `Pass` | Linkify without raw HTML execution |
| Frontmatter parsed safely | `Pass` | Static YAML, no prototype pollution vector |
| Encoded for downstream context | `Flagged` | Error fallback path is unescaped (`RSEC-009`) |

---

## 7. Secure Coding Practices Review

### Input Validation & Output Encoding
| Practice | Status | Evidence |
| :--- | :--- | :--- |
| Inputs validated at trust boundaries | `Pass` | Zod schemas on every MCP tool argument |
| Allowlists preferred over denylists | `Flagged` | The command **binary** is allowlisted, but the surrounding command string is guarded by a metacharacter **denylist** that both packages implement incompletely |
| Type, length, format, range validation | `Pass` | Ports, line counts, and date strings bounded |
| Context-aware output encoding | `Flagged` | Markdown error fallback omits HTML escaping (`RSEC-009`) |

### Cryptography Implementation
| Practice | Status | Evidence |
| :--- | :--- | :--- |
| Industry-standard algorithms | `Pass` | SHA-256; platform keystores for credentials |
| Secure key storage | `Pass` | macOS Keychain, Windows DPAPI, 0600 fallback |
| Authenticated encryption | `Pass` | Delegated to ssh2 and TLS cipher negotiation |

### Secrets Management
| Practice | Status | Evidence |
| :--- | :--- | :--- |
| No hardcoded secrets | `Pass` | Verified by scan and manual review |
| Vault or environment usage | `Pass` | `loadEnv()` from Keychain, DPAPI, or `~/.raven/.env` |
| Secret detection in logs | `Needs Review` | `PiScrubber` active; misses short credential values (`RSEC-004`) |
| Secrets never persisted in cleartext | `Flagged` | Push credentials transiently written to `.git/config` (`RSEC-008`) |

### Session Handling & API Security
| Practice | Status | Evidence |
| :--- | :--- | :--- |
| Secure session lifetime | `Pass` | ~25-minute TTL |
| Session invalidation | `Pass` | `clearCachedSession` unlinks the cache |
| Authentication on all API endpoints | `Flagged` | `server-ui` has none (`RSEC-005`) |
| Rate limiting | `Pass` | `TokenBucket`, `CircuitBreaker`, `wrapSshExecWithLimits` |

---

## 8. Architecture Security Assessment

### Trust Boundary Analysis

| Trust Boundary | Data Flow | Validation | Risk |
| :--- | :--- | :--- | :--- |
| AI assistant ↔ MCP servers | JSON-RPC over stdio | Zod schemas; PI scrubbing | Medium — the argument channel is the injection vector for `RSEC-001` / `RSEC-002` |
| Browser ↔ Server UI (`127.0.0.1:3777`) | HTTP REST and SSE | None — no auth, CORS, Origin, Host, or CSRF control | Medium |
| MCP servers ↔ application servers (SSH 22) | ssh2 with sudo | Incomplete metacharacter denylists; host key verification disabled | **High** |
| MCP servers ↔ BC Gov Atlassian | HTTPS, SiteMinder or Basic | Validated endpoints, rate limited | Low |
| Pipeline ↔ Bitbucket | Git over HTTPS | Validated clone URLs; transient credential in `.git/config` | Low |

### Attack Surface Assessment

| Surface | Exposure | Auth Required | Risk |
| :--- | :--- | :--- | :--- |
| `127.0.0.1:3777` Server UI | Loopback, reachable cross-origin and via DNS rebinding | **No** | Medium |
| 17 MCP stdio endpoints | Local process | Implicit (process invocation) | Medium |
| Outbound SSH to government servers | Intranet / DMZ over VPN | SSH credential + sudo password | **High** |
| Outbound HTTPS to Atlassian / DevOps / SharePoint | Internet and intranet | Session cookie, PAT, or token | Low |

### Privilege Escalation Analysis

| Boundary | Elevation Path | Risk | Mitigation |
| :--- | :--- | :--- | :--- |
| SSH user → `sudoUser` service account | Metacharacter breakout in `buildLogSearchCommand` (`RSEC-001`) or newline breakout in `validateCommand` (`RSEC-002`) executes arbitrary commands under `wwwsvr`, `oracle`, `tomcat` and similar | **High** | Replace denylists with per-argument escaping or argv-style execution |
| Web page → local server configuration | CSRF or DNS rebinding to `PUT /api/servers` rewrites `~/bin/servers.conf` (`RSEC-005`) | Medium | Origin and Host validation plus a custom-header requirement |
| Attacker-authored log or ticket text → shell | Prompt injection routes tainted text into a tool argument that reaches either sink | **High** | Same fix as above; the scrubber does not and cannot mitigate this |

### Data Flow Security

| Data Category | In Transit | At Rest | Retention | Sanitization |
| :--- | :--- | :--- | :--- | :--- |
| Upstream credentials | HTTPS / SSH | Keychain or DPAPI; 0600 `.env` fallback | Process lifetime; session ~25 min | Scrubbed from logs |
| Enterprise content (tickets, pages, logs) | HTTPS / SSH | Memory only | Not retained | `PiScrubber`, with gaps |
| Audit records | Local only | Plaintext JSONL, mode 0600 | **Indefinite, no rotation** | Scrubbed, with gaps |
| Cloned repositories | HTTPS | `~/.raven/repos` | Retained across runs | Partial — see `RSEC-008` |

---

## 9. Supply Chain Security

### Dependency Analysis & Lockfile Security
| Check | Status | Detail |
| :--- | :--- | :--- |
| Lockfile present and current | `Pass` | `package-lock.json` at `fd982f6` |
| Lockfile integrity | `Pass` | SHA-512 integrity hashes |
| Dependency tree reviewed | `Pass` | 20 direct dependencies, all mainstream publishers |
| Dependency confusion | `Pass` | Private `@nrs/` scope |
| Automated surveillance | `Pass` | Dependabot merging advisory fixes within days |

### Third-Party Component Risks
| Component | Provenance | Maintained | Track Record | Risk |
| :--- | :--- | :--- | :--- | :--- |
| `@modelcontextprotocol/sdk` | Anthropic | Active | Good | Low |
| `@github/copilot-sdk` | GitHub | Active | Good | Low |
| `ssh2` | mscdex | Active | Established | Low |
| `playwright` | Microsoft | Active | Excellent | Low |
| `express` | OpenJS | Active | Industry standard | Low |
| `nodemailer` | Nodemailer | Active | Frequent advisories; recently required a major bump | Low–Medium |

---

## 10. DevSecOps Configuration Review

### Security Headers
| Header | Status | Detail |
| :--- | :--- | :--- |
| `Content-Security-Policy` | `Missing` | Not set on Server UI (`RSEC-011`) |
| `X-Content-Type-Options` | `Missing` | Not set |
| `X-Frame-Options` | `Missing` | Not set — dashboard is frameable |
| `Referrer-Policy` | `Missing` | Not set |
| `Strict-Transport-Security` | `N/A` | Plain HTTP on loopback |

### CORS & Rate Limiting
| Control | Status | Detail |
| :--- | :--- | :--- |
| CORS origin allowlist | `Missing` | No origin or Host validation |
| Rate limiting, upstream | `Configured` | `TokenBucket`, `CircuitBreaker` |
| Rate limiting, SSH | `Configured` | `wrapSshExecWithLimits` |

### Container Security
| Check | Status | Detail |
| :--- | :--- | :--- |
| Container image | `N/A` | No Dockerfile; runs on a developer workstation |
| Non-root execution | `Pass` | Runs as the logged-in user |

### CI/CD Pipeline Security
| Check | Status | Detail |
| :--- | :--- | :--- |
| Least-privilege token | `Pass` | `permissions: contents: read` |
| Pinned actions | `Pass` | `actions/checkout@v7`, `actions/setup-node@v7` |
| Build and test gate | `Pass` | Real `tsc` build plus full `vitest` suite |
| Contract drift gate | `Pass` | `gen-inventory:check` |
| **Security scanning gate** | `Missing` | No SAST, SCA, or `npm audit` step; the workflow header defers CodeQL to repository settings (`RSEC-013`) |

---

## 11. Advanced Security Frameworks

### OWASP ASVS & CWE Mapping

Status reflects §0. `RSEC-008` onward were out of the agreed remediation scope.

| Finding | ASVS | CWE | MITRE ATT&CK | Status |
| :--- | :--- | :--- | :--- | :--- |
| `RSEC-001` | V5.3.8 | CWE-78 | T1059.004 | **Fixed** |
| `RSEC-002` | V5.3.8 | CWE-78 / CWE-88 | T1059.004 | **Fixed** |
| `RSEC-003` | V5.3.8 | CWE-78 | T1059.004 | **Fixed** |
| `RSEC-004` | V8.3.1 | CWE-359 | T1552.001 | **Fixed** |
| `RSEC-005` | V4.2.1 / V4.1.1 | CWE-352 / CWE-284 | T1190 | **Fixed** |
| `RSEC-006` | V6.2.1 | CWE-295 | T1557 | **Fixed** |
| `RSEC-007` | V9.2.1 | CWE-295 | T1557 | **Fixed** |
| `RSEC-008` | V8.3.1 | CWE-522 | T1552.001 | Open |
| `RSEC-009` | V5.3.3 | CWE-79 | T1189 | Open |
| `RSEC-010` | V12.6.1 | CWE-918 | T1190 | Open |
| `RSEC-011` | V14.4.1 | CWE-1021 | T1189 | Open |

### STRIDE Threat Model Summary

| Component | Spoofing | Tampering | Repudiation | Info Disclosure | DoS | Elevation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **server-mcp (SSH)** | 🟡 no host key check | 🔴 command injection | 🟢 audit logged | 🟡 sudo password on stdin | 🟢 timeouts | 🔴 sudo escalation |
| **imis-mcp (SSH)** | 🟡 no host key check | 🔴 newline injection | 🟢 audit logged | 🟡 sudo password on stdin | 🟢 timeouts | 🔴 sudo escalation |
| **server-ui (:3777)** | 🟡 no auth | 🟡 config rewrite via CSRF | 🟢 request logger | 🟡 log download | 🟡 ReDoS | 🟡 CSRF |
| **pipeline (Copilot)** | 🟢 verified push URLs | 🟡 reaches the injectable sink unattended | 🟢 commit hashes | 🟡 transient credential in `.git/config` | 🟢 clamped timeouts | 🟢 no model tool access |
| **auth (@nrs/auth)** | 🟢 SiteMinder SSO | 🟢 hash-chained | 🟢 tamper-evident | 🟡 scrubber gaps | 🟢 token bucket | 🟢 0600 modes |

*Legend:* 🔴 High · 🟡 Medium · 🟢 Low

---

## 12. Vulnerability Findings Detail

### [SEVERITY: Critical] RSEC-001: Remote Command Injection via Single-Quote Breakout in Server MCP Log Search

- **Classification:** `Confirmed` (reproduced)
- **Location:** `packages/server-mcp/src/commands/log-search.ts:46`, `:72-120`, `:162-210`; sink wrapped at `packages/server-mcp/src/ssh-client.ts:117-132`
- **OWASP:** A05:2025 — Injection · **CWE-78** · **CVSS 8.8** `[AI-estimated]` (`AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`)

#### Description

`buildLogSearchCommand` interpolates a caller-supplied `pattern` into a shell command inside single quotes, guarded only by a denylist that omits the single quote itself:

```typescript
// packages/server-mcp/src/commands/log-search.ts:46
const PATTERN_META = /[;&`$(){}\\<>]/;
```

`'`, `|`, `"`, `\r` and `\n` are all absent. The pattern is then emitted as `grep ${grepOpts} '${pattern}' ${file}`, so a quote closes the literal and the rest executes.

`buildRemoteCommand` wraps the finished string in `sudo -S -p '' -u <sudoUser> bash -c <escaped>`. The `shellEscape` there protects only the **outer** `bash -c` argument — the injected pipeline lives inside that string and the inner shell re-parses it. It runs as the target service account.

#### Reproduction

```text
ACCEPTED pattern="FATAL' | id | '"
  if [ -f /apps_ux/logs/RRS/rrs/rrs.log ]; then grep -E -n -a 'FATAL' | id | '' /apps_ux/logs/RRS/rrs/rrs.log | tail -100; ...
```

#### Reachability

`trace_path` over the indexed graph returns **seven callers across four packages**:

| Caller | Hops | Significance |
| :--- | :--- | :--- |
| `server-mcp.commands.log-search.searchLogs` | 1 | Direct wrapper |
| `server-mcp.server.createServerMonitoringServer` | 2 | MCP tool boundary |
| `server-ui.routes.logs` | 2 | Unauthenticated HTTP route |
| `server-ui.routes.pool` | 2 | Second unauthenticated route |
| `pipeline.steps.detect.scanLogs` | 2 | **Autonomous scheduled pipeline** |
| `pipeline.steps.detect.detect` | 3 | Pipeline triage |
| `pipeline.orchestrator.runPipeline` | 4 | Unattended entry point |

The `pipeline` reach is the material one: that path runs on a schedule with no human in the loop and consumes remote log content, so attacker-influenced text in a monitored log can reach a shell sink unattended.

#### Remediation

Escape the pattern per-argument rather than extending the denylist:

```typescript
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
// interpolate without adding quotes of your own:
`grep ${grepOpts} ${shellEscape(pattern)} ${dated} | tail -${maxLines}`
```

Adding `'"|\r\n` to `PATTERN_META` is an acceptable stopgap but leaves the fragile pattern in place.

---

### [SEVERITY: Critical] RSEC-002: Command Injection via Newline Bypass of the IMIS Allowlist

- **Classification:** `Confirmed` (reproduced)
- **Location:** `packages/imis-mcp/src/ssh-executor.ts:30`, `:37-42`, `:150-157`
- **OWASP:** A05:2025 — Injection · **CWE-78 / CWE-88** · **CVSS 8.8** `[AI-estimated]`

#### Description

```typescript
// packages/imis-mcp/src/ssh-executor.ts:30
const SHELL_META = /[;&|`$(){}\\<>]/;

// :37-42
export function validateCommand(command: string): boolean {
  if (SHELL_META.test(command)) return false;
  const firstToken = command.trim().split(/\s+/)[0];
  return ALLOWED_COMMANDS.has(firstToken);
}
```

This denylist correctly blocks `|` and `;` — where `server-mcp` does not — but omits `\n` and `\r`. Worse, `split(/\s+/)` treats a newline as whitespace, so `firstToken` resolves to the harmless leading binary while the payload survives on the next line. `buildRemoteCommand` then concatenates the string straight into the remote shell, where a newline is a statement separator.

The two packages implementing near-identical guards with *different* gaps is the underlying defect.

#### Reproduction

```text
ACCEPTED  "cat /etc/hosts\nid"     ← newline bypass
ACCEPTED  "cat /etc/hosts\rid"     ← carriage-return bypass
ACCEPTED  "grep 'foo' /tmp/x"      ← quote permitted
rejected  "cat /etc/hosts | id"
rejected  "cat /etc/hosts; id"
```

#### Remediation

Add `'"\r\n` to `SHELL_META`, and escape each interpolated argument individually. Extract one shared, tested command-construction helper so `server-mcp` and `imis-mcp` cannot drift again. Add the payloads above as regression tests.

---

### [SEVERITY: High] RSEC-003: `sanitizePath` Accepts Newline and Quote Characters

- **Classification:** `Confirmed` (reproduced)
- **Location:** `packages/imis-mcp/src/ssh-executor.ts:45-56`; consumed at `packages/imis-mcp/src/server.ts:305-306` and `:389-391`
- **OWASP:** A05:2025 — Injection · **CWE-78**

#### Description

`sanitizePath` rejects relative paths, `..` traversal, and `SHELL_META` — inheriting the same incomplete denylist. Its return value is interpolated **unquoted**:

```typescript
// packages/imis-mcp/src/server.ts:389-391
const safePath = sanitizePath(path);
const command = `head -n ${maxLines} ${safePath}`;
```

```text
ACCEPTED "/var/log/x\nid"     → newline survives
ACCEPTED "/var/log/it's.log"  → quote survives
rejected "/var/../etc/passwd"
```

`trace_path` confirms a single entry point, `imis-mcp.server.createImisServer` — the MCP tool boundary — so this is the delivery vector for `RSEC-002` and must be fixed alongside it.

#### Remediation

Extend `SHELL_META`, and quote the interpolation: `` `head -n ${maxLines} ${shellEscape(safePath)}` ``.

---

### [SEVERITY: High] RSEC-004: PI Scrubber Fails to Redact Unseparated SIN, Phone, and Bare IDIR

- **Classification:** `Confirmed` (reproduced)
- **Location:** `packages/auth/src/pi-scrubber.ts:42-60`
- **CWE-359** · **Compliance: FOIPPA s.30**

#### Description

`PI_PATTERNS` makes the separator **mandatory** in the SIN and phone patterns, despite the comment describing it as optional, and matches an IDIR only after a labelling prefix:

```typescript
// packages/auth/src/pi-scrubber.ts:51
{ pattern: /\b\d{3}[\s-]\d{3}[\s-]\d{3}\b/g, replacement: "[SIN]" },
// :55
{ pattern: /(?:username|author|idir)[:=]\s*[A-Z]{3,8}\b/gi, replacement: "[IDIR]" },
```

#### Reproduction

```text
SCRUBBED  "SIN 123-456-789"              → "SIN [SIN]"
LEAKED    "SIN 123456789"                → unchanged
SCRUBBED  "call 250-555-1234"            → "call [PHONE]"
LEAKED    "call 2505551234"              → unchanged
SCRUBBED  "username: JSMITH"             → "[IDIR]"
LEAKED    "assigned to JSMITH today"     → unchanged
SCRUBBED  "password=SuperSecret12345678" → "[CREDENTIAL]"
LEAKED    "password=Secret12"            → unchanged (16-char minimum)
```

`scrubText` is the last control before enterprise content reaches a model and before audit records are written. A nine-digit SIN written without separators is the common machine-readable form. This is the highest-value fix in the document on a compliance basis, notwithstanding that the two Criticals carry higher CVSS.

A method caveat: `trace_path` reports **0 callers** for `scrubText` while `grep` finds **138** — the resolver does not link instance calls through a module singleton. Graph absence is not evidence of absence.

#### Remediation

Make separators optional and add a bare nine-digit SIN branch with a Luhn check to limit false positives; make the phone separator optional; add a standalone IDIR pattern; lower the credential minimum to about 8 characters. Over-redaction is the safe failure direction for a FOIPPA control. Add each probe string above as a regression test.

---

### [SEVERITY: Medium] RSEC-005: Unauthenticated Local Web Interface with No CSRF or Origin Control

- **Classification:** `Confirmed`
- **Location:** `packages/server-ui/src/server.ts:32-58`
- **CWE-352 / CWE-284** · **CVSS 6.5** `[AI-estimated]`

`createApp()` mounts fifteen routers — including `GET/PUT /api/servers` and `GET /api/logs/download` — with `express.json()` and a request logger, and no authentication, authorization, CORS, Origin, Host, or CSRF middleware. Any local process, or any website the operator visits via cross-origin request or DNS rebinding, can read the server inventory (hostnames, SSH users, sudo accounts) or overwrite `~/bin/servers.conf`.

**Remediation.** Add Host and Origin validation middleware restricted to `localhost:3777` and `127.0.0.1:3777`; require a custom header such as `X-Raven-UI: 1` on state-changing requests; and reject `\n`, `\r`, and `|` in values written to `servers.conf`.

---

### [SEVERITY: Medium] RSEC-006: SSH Host Key Verification Disabled in Both SSH Clients

- **Classification:** `Confirmed`
- **Location:** `packages/server-mcp/src/ssh-client.ts:163` **and** `packages/imis-mcp/src/ssh-executor.ts:186`
- **CWE-295** · **CVSS 6.8** `[AI-estimated]`

Both clients set `hostVerifier: () => true`, accepting any presented host key. Both then transmit the SSH credential and pipe the sudo password over stdin, so an on-path attacker can capture both.

To the code's credit, `imis-mcp/src/ssh-executor.ts:221-228` documents this as a deliberate decision treating the VPN tunnel as the trust boundary, matching legacy `server-cmd.exp` behaviour. That is a defensible position for an internal network — but it is currently implicit, untracked, and duplicated. Any remediation must cover **both** sites; fixing only the one commonly cited leaves an equivalent path open.

**Remediation.** Verify against `~/.ssh/known_hosts`, and gate the bypass behind a single shared `RAVEN_SSH_INSECURE_HOST_KEYS` flag so the exception is explicit and auditable. Record the decision as an ADR.

---

### [SEVERITY: Medium] RSEC-007: TLS Certificate Validation Unconditionally Disabled for SMTP Alerts

- **Classification:** `Confirmed`
- **Location:** `packages/server-ui/src/lib/collector.ts:306`
- **CWE-295** · **CVSS 5.9** `[AI-estimated]`

```typescript
tls: { rejectUnauthorized: false },
```

Applied to every alert email. When `SMTP_USER` and `SMTP_PASSWORD` are configured, credentials and alert bodies — which carry internal hostnames and stack traces — can be intercepted by an on-path attacker presenting a forged certificate.

**Remediation.** Remove the default and gate it behind an explicit opt-in such as `SMTP_INSECURE_TLS=true`.

---

### [SEVERITY: Low] RSEC-008: Push Credentials Transiently Written to `.git/config`

- **Classification:** `Probable`
- **Location:** `packages/pipeline/src/steps/create-pr.ts:63-81`
- **CWE-522** · **CVSS 3.3** `[AI-estimated]`

The pipeline sets an authenticated push URL containing the operator's password via `git remote set-url --push`, then restores the clean URL in a `finally` block. Abnormal termination (SIGKILL, power loss) leaves the plaintext credential in `~/.raven/repos/<project>/<repo>/.git/config`.

**Remediation — the fix already exists in this repository.** `packages/bitbucket-mcp/src/server.ts:605-616` already uses the correct pattern:

```typescript
const credentials = btoa(`${email}:${password}`);
authHeader = `Authorization: Basic ${credentials}`;
// ...
`http.extraHeader=${authHeader}`,
```

Porting that to `create-pr.ts` is a copy of proven in-repo code, not a new design, which makes this materially cheaper to close than its Low severity suggests.

---

### [SEVERITY: Low] RSEC-009: Unescaped Markdown in the Confluence HTML Converter Fallback

- **Classification:** `Probable`
- **Location:** `packages/confluence-mcp/src/markdown-to-html.ts:48-56`
- **CWE-79** · **CVSS 3.8** `[AI-estimated]`

`markdownToHtml` correctly configures `markdown-it` with `html: false`, but its catch block returns `` `<p>${markdown}</p>` `` with the input unescaped. If a render throws on untrusted content, raw markup is injected into Confluence storage format. Rated Probable because `markdown-it` rarely throws.

**Remediation.** HTML-escape the fallback.

---

### [SEVERITY: Low] RSEC-010: Incomplete SSRF Validation in Server UI Webhooks

- **Classification:** `Probable`
- **Location:** `packages/server-ui/src/routes/alerts.ts`, `isAllowedWebhookUrl`
- **CWE-918** · **CVSS 3.7** `[AI-estimated]`

The check requires HTTPS, blocks `localhost` and `[::1]`, and rejects literal private IPv4 ranges including `169.254.0.0/16`. It performs **no DNS resolution**, so a hostname resolving to `127.0.0.1` or a cloud metadata address passes. No `dns.*` call exists anywhere in `packages/server-ui/src`.

**Remediation.** Resolve the hostname at dispatch time and re-check the resolved addresses against the same private-range rules.

---

### [SEVERITY: Informational] RSEC-011: Missing HTTP Security Headers on the Local Dashboard

- **Classification:** `Confirmed` · **Location:** `packages/server-ui/src/server.ts` · **CWE-1021**

No `helmet` or manual headers. `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy` are all absent, so the dashboard is frameable by any local or intranet page.

**Remediation.** Mount `helmet` in `createApp()`.

---

### [SEVERITY: Informational] RSEC-012: No Code Coverage Provider Is Installed

- **Classification:** `Confirmed` · **Location:** root `package.json`, `origin/main`

Coverage reports `0.0%` and fails the quality gate's `new_coverage` condition. The cause is not scan configuration: there is **no coverage provider in the dependency tree at all**. A `vitest.config.ts` does exist and sets `globals` and `include`, but it declares no `coverage` block, `@vitest/coverage-v8` is absent, and `"test": "vitest run"` carries no `--coverage`. Enabling `runTests` on a scan would still yield 0%, because no LCOV report is ever produced.

**Remediation.** `npm i -D @vitest/coverage-v8`; add a `coverage: { reporter: ['text','lcov'] }` block to the existing `vitest.config.ts`; add a `"test:coverage"` script; re-scan to establish a real baseline before setting any coverage threshold.

---

### [SEVERITY: Informational] RSEC-013: CI Has No Security Scanning Gate

- **Classification:** `Confirmed` · **Location:** `.github/workflows/ci.yml`

The workflow is well built — least-privilege `permissions`, pinned actions, concurrency cancellation, a real build, the full test suite, and an inventory drift gate. It contains no SAST, SCA, or `npm audit` step, and its own header comment defers CodeQL to repository settings. A dependency advisory published after a merge is caught only by Dependabot's own schedule, never by a gate on the change itself.

**Remediation.** Add `npm audit --audit-level=high` as a CI step, and enable CodeQL in repository settings. This directly supports the stated goal of automating dependency maintenance.

---

## 13. Action Items & Remediation Roadmap

| Priority | Findings | Recommended Action | Owner |
| :--- | :--- | :--- | :--- |
| **P1 — Critical** | `RSEC-001`, `RSEC-002`, `RSEC-003` | One shell-injection defect class across two packages. Extract a single shared, tested command builder using per-argument escaping; fix both denylists; add the reproduced payloads as regression tests. **Shipping only one package leaves a live path.** | Core / Security |
| **P1 — Compliance** | `RSEC-004` | Fix the PI scrubber patterns. Cheap, high consequence, and it is the control the FOIPPA posture depends on. | Auth / Core |
| **P2** | `RSEC-005` | Origin and Host validation plus a custom-header requirement on `server-ui`; sanitize `servers.conf` writes. | Server UI |
| **P2** | `RSEC-006` | `known_hosts` verification at **both** SSH sites behind one opt-in flag; record as an ADR. | Infrastructure |
| **P3** | `RSEC-007` | Gate SMTP TLS bypass behind `SMTP_INSECURE_TLS`. | Server UI |
| **P3** | `RSEC-008` | Port the `bitbucket-mcp` `http.extraHeader` pattern into `create-pr.ts`. | Pipeline |
| **P4** | `RSEC-009`, `RSEC-010`, `RSEC-011` | Escape the markdown fallback; resolve DNS before webhook dispatch; mount `helmet`. | Respective owners |
| **P4** | `RSEC-012`, `RSEC-013` | Install a coverage provider; add `npm audit` and CodeQL gates to CI. Do these before trusting any future scan trend. | Build / DevOps |
| **P5** | Sonar hygiene | Triage the 28 hotspots — mark the 3 test-fixture High items *Safe* so real credential hotspots are not buried; review the 8 ReDoS Mediums that parse remote responses. Fix the 9 `sort()` comparator bugs, which also close the Unicode ordering gap in `docs/architecture.md`. | Core |

---

## 14. Assessment

RAVEN's security design is sound and, in several respects, better than typical for an internal tool: delegated authorization means the software never holds more authority than the person running it; the audit log is hash-chained and tamper-evident; upstream services are protected by client-side throttling and circuit breaking; credentials live in platform keystores; and a privacy control runs before content reaches a model. Dependency hygiene is genuinely good — `npm audit` is clean at `fd982f6` and Dependabot closed four advisory classes within nine days.

The findings are implementation gaps in existing controls, not missing controls. Two themes account for most of the risk.

**The first is duplicated security-critical logic.** Two SSH clients and two shell-metacharacter denylists were written separately and have already drifted: `imis-mcp` blocks the pipe character, `server-mcp` does not; neither blocks newline or quote. This is why `RSEC-001` and `RSEC-002` are one defect reported twice, and why a remediation scoped to a single package would close a ticket without closing the hole. The durable fix is one shared, tested command builder — consolidation, not more denylist entries.

**The second is that the most exposed path is the least attended.** `trace_path` shows the injectable log-search sink is reachable from the autonomous pipeline, which runs on a schedule, consumes remote log content, and has no human in the loop. Combined with an unauthenticated local dashboard that reaches the same sink, the practical attack is prompt or content injection through a ticket or a log line rather than anything requiring network position.

Two process notes worth carrying forward. This review was initially run against a working tree nine commits stale and reached the wrong dependency conclusion; pinning the ref is not bureaucratic, it is the difference between a correct and an incorrect report. And SonarQube SCA is disabled on this server, so any dependency claim tagged `[SonarQube]` asserts a confirmation that never happened — `npm audit` is the evidence source here.

None of this is an emergency. Both Criticals need attacker-influenced text to reach a tool argument, which means a motivated adversary already writing into a ticket or a monitored log — real, but not remote-unauthenticated. The P1 set is roughly a day of focused work and closes the class rather than the instances.
