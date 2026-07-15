// Imported FIRST by gen-inventory.mjs, before any server factory.
//
// `server-mcp` reads ~/bin/servers.conf at *module load* (its tool schemas embed
// the configured server names as a z.enum) and throws if it finds no entries —
// which is the case on a CI runner or any machine without server monitoring set
// up. The generator only needs each server's static tool list, so we point the
// host-config-dependent servers at throwaway placeholders before their modules
// evaluate. This must run before @nrs/auth's server-config module reads
// SERVER_TOOLS_BIN (a module-level const), hence the import-first ordering.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reuse one fixed dir so repeated runs don't accumulate temp directories.
const dir = join(tmpdir(), "raven-gen-inventory");
mkdirSync(dir, { recursive: true });

// server-mcp: needs >=1 entry; format is name|host|sshUser|sudoUser|role|desc
writeFileSync(join(dir, "servers.conf"), "geninv|localhost|placeholder|placeholder|placeholder|inventory generation only\n");
process.env.SERVER_TOOLS_BIN = dir;

// imis-mcp reads its CSV lazily, but point it at an empty placeholder for safety.
const csv = join(dir, "imis-servers.csv");
writeFileSync(csv, "");
process.env.IMIS_CSV_PATH = csv;
