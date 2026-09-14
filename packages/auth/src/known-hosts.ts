/**
 * SSH host key verification against `~/.ssh/known_hosts` (RSEC-006).
 *
 * Both SSH clients in this repository previously set `hostVerifier: () => true`,
 * accepting whatever key a host presented. They then sent the operator's SSH
 * credential and piped the sudo password over stdin, so an on-path attacker who
 * could answer for the target address captured both.
 *
 * The original code documented this as a deliberate choice treating the VPN
 * tunnel as the trust boundary. That is a defensible position, but it was
 * implicit, duplicated across two packages, and impossible to audit. It is now
 * a single explicit opt-in: set `RAVEN_SSH_INSECURE_HOST_KEYS=true`.
 *
 * Lives in `@nrs/auth` rather than in either MCP package so the two clients
 * cannot drift apart again — drift between their two copies of this logic is
 * what produced separate findings for one defect.
 */
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvVar } from "./load-env.js";

/** Environment flag that restores the previous accept-anything behavior. */
export const INSECURE_HOST_KEYS_ENV = "RAVEN_SSH_INSECURE_HOST_KEYS";

/** Hosts already warned about, so an insecure-mode run logs once per host. */
const warned = new Set<string>();

/** One parsed known_hosts entry. */
export interface KnownHostsEntry {
  /** Literal host patterns, empty when the entry is hashed. */
  hosts: string[];
  /** Base64 salt for a `|1|` hashed entry, else null. */
  hashSalt: string | null;
  /** Base64 HMAC-SHA1 of the hostname for a hashed entry, else null. */
  hashValue: string | null;
  /** Base64 public key blob, as ssh2 presents it. */
  key: string;
}

/**
 * Parse the contents of a known_hosts file.
 *
 * Understands plain comma-separated host lists and the `|1|salt|hash` hashed
 * form written by `HashKnownHosts yes`. Marker lines (`@cert-authority`,
 * `@revoked`) are skipped: this verifier deliberately does not honour
 * certificate authorities, because doing so would widen trust silently.
 *
 * @param contents - Raw file contents.
 * @returns Parsed entries, ignoring comments and unparseable lines.
 */
export function parseKnownHosts(contents: string): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostField, , keyB64] = parts as [string, string, string];

    if (hostField.startsWith("|1|")) {
      const segments = hostField.split("|");
      // Format: "" | "1" | salt | hash
      if (segments.length !== 4) continue;
      entries.push({ hosts: [], hashSalt: segments[2]!, hashValue: segments[3]!, key: keyB64 });
    } else {
      entries.push({
        hosts: hostField.split(",").map((h) => h.toLowerCase()),
        hashSalt: null,
        hashValue: null,
        key: keyB64,
      });
    }
  }
  return entries;
}

/**
 * Test whether an entry covers a hostname.
 *
 * @param entry - Parsed known_hosts entry.
 * @param host - Hostname or address being contacted.
 * @returns True when the entry names this host.
 */
function entryMatchesHost(entry: KnownHostsEntry, host: string): boolean {
  const target = host.toLowerCase();

  if (entry.hashSalt && entry.hashValue) {
    const mac = createHmac("sha1", Buffer.from(entry.hashSalt, "base64"));
    mac.update(target);
    return mac.digest("base64") === entry.hashValue;
  }

  // Plain entries may carry a bracketed non-default port, e.g. [host]:2222.
  return entry.hosts.some((h) => h === target || h === `[${target}]:22`);
}

/**
 * Resolve the known_hosts path, honouring an override for tests.
 *
 * @returns Absolute path to the known_hosts file to consult.
 */
export function knownHostsPath(): string {
  return loadEnvVar("RAVEN_KNOWN_HOSTS_PATH") ?? join(homedir(), ".ssh", "known_hosts");
}

/** Outcome of a host key check. */
export type HostKeyVerdict =
  | { ok: true; reason: "insecure-opt-in" | "matched" }
  | { ok: false; reason: "no-known-hosts-file" | "host-not-found" | "key-mismatch"; message: string };

/**
 * Verify a presented host key for a host.
 *
 * @param host - Hostname or address being contacted.
 * @param key - Public key blob exactly as ssh2 supplies it to `hostVerifier`.
 * @param contents - known_hosts contents, or null when the file is absent.
 * @returns A verdict describing whether the connection may proceed and why.
 */
export function verifyHostKey(
  host: string,
  key: Buffer,
  contents: string | null,
): HostKeyVerdict {
  if (contents === null) {
    return {
      ok: false,
      reason: "no-known-hosts-file",
      message:
        `No known_hosts file at ${knownHostsPath()}, so the identity of "${host}" cannot be ` +
        `verified. Connect once with the ssh client to record the key, or set ` +
        `${INSECURE_HOST_KEYS_ENV}=true in ~/.raven/.env to accept any key (previous behavior).`,
    };
  }

  const presented = key.toString("base64");
  const entries = parseKnownHosts(contents).filter((e) => entryMatchesHost(e, host));

  if (entries.length === 0) {
    return {
      ok: false,
      reason: "host-not-found",
      message:
        `"${host}" is not present in ${knownHostsPath()}. Connect once with the ssh client to ` +
        `record its key, or set ${INSECURE_HOST_KEYS_ENV}=true in ~/.raven/.env to accept any ` +
        `key (previous behavior).`,
    };
  }

  if (entries.some((e) => e.key === presented)) {
    return { ok: true, reason: "matched" };
  }

  return {
    ok: false,
    reason: "key-mismatch",
    message:
      `HOST KEY MISMATCH for "${host}". The key it presented does not match the one recorded in ` +
      `${knownHostsPath()}. This is what an interception attempt looks like. Do not set ` +
      `${INSECURE_HOST_KEYS_ENV} to work around it — confirm the change with the server owner ` +
      `first, then update known_hosts.`,
  };
}

/**
 * Build an ssh2 `hostVerifier` for a host.
 *
 * Returns a synchronous predicate, matching the signature both SSH clients
 * already use. On rejection the reason is written to stderr, because a bare
 * `false` surfaces to the caller as an unexplained handshake failure.
 *
 * @param host - Hostname or address being contacted.
 * @returns Predicate suitable for ssh2's `hostVerifier` option.
 */
export function createHostVerifier(host: string): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    if (loadEnvVar(INSECURE_HOST_KEYS_ENV) === "true") {
      if (!warned.has(host)) {
        warned.add(host);
        process.stderr.write(
          `[raven] ${INSECURE_HOST_KEYS_ENV}=true — accepting any SSH host key for "${host}". ` +
          `Credentials sent over this connection can be captured by an on-path attacker.\n`,
        );
      }
      return true;
    }

    const path = knownHostsPath();
    const contents = existsSync(path) ? readFileSync(path, "utf8") : null;
    const verdict = verifyHostKey(host, key, contents);
    if (!verdict.ok) {
      process.stderr.write(`[raven] SSH host key rejected: ${verdict.message}\n`);
      return false;
    }
    return true;
  };
}
