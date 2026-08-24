#!/usr/bin/env node
// setup-credentials-mac.mjs
// Stores RAVEN credentials in the macOS login keychain as a single
// generic-password item (service "raven", account "credentials") holding a
// base64-encoded JSON blob — the macOS counterpart of setup-credentials.ps1's
// DPAPI file. The keychain encrypts the blob at rest and scopes it to your
// macOS user; loadEnv() reads it back at server startup.
//
// Usage (from repo root, after `npm run build`):
//   node scripts/setup-credentials-mac.mjs            # create/update
//   node scripts/setup-credentials-mac.mjs --verify   # list stored keys, masked
//
// To delete stored credentials:
//   security delete-generic-password -s raven -a credentials
//
// Set RAVEN_KEYCHAIN_SERVICE to use a scratch service name when testing.
//
// The whole credential record is written in a single `security -i` command;
// `security -i` reads stdin in ~4095-byte chunks, so the encoded record has
// a hard ceiling around that size. writeKeychainRecord() enforces it.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseDotenv } from "dotenv";
import {
  readKeychainRecord,
  writeKeychainRecord,
  keychainService,
  KEYCHAIN_ACCOUNT,
  KeychainReadError,
} from "../packages/auth/dist/load-env.js";
import { mask, seedDefaults } from "./setup-credentials-mac.lib.mjs";

/** Values from ~/.raven/.env, used as first-run defaults; {} when absent. */
function readEnvFile() {
  try {
    return parseDotenv(readFileSync(join(homedir(), ".raven", ".env"), "utf-8"));
  } catch {
    return {};
  }
}

/**
 * One readline interface for the whole session — a fresh interface per
 * question would buffer and discard piped stdin, hanging every question
 * after the first. Sensitive questions suppress the echo of typed
 * characters; stdin ending early (Ctrl-D, short pipe) answers blank.
 */
function createPrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  let closed = false;
  let pending = null;
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (!muted) write(s);
  };
  rl.on("close", () => {
    closed = true;
    pending?.("");
  });
  return {
    ask(question, { sensitive = false } = {}) {
      return new Promise((resolve) => {
        // stdin already ended (short pipe / Ctrl-D): keep remaining defaults.
        if (closed) {
          resolve("");
          return;
        }
        pending = resolve;
        if (sensitive) {
          process.stdout.write(`${question}: `);
          muted = true;
        }
        rl.question(sensitive ? "" : `${question}: `, (answer) => {
          if (sensitive) {
            muted = false;
            process.stdout.write("\n");
          }
          pending = null;
          resolve(answer.trim());
        });
      });
    },
    close() {
      pending = null;
      rl.close();
    },
  };
}

// --- Verify mode ---
if (process.argv.includes("--verify")) {
  let stored;
  try {
    stored = readKeychainRecord();
  } catch (err) {
    if (!(err instanceof KeychainReadError)) throw err;
    console.log(err.message);
    process.exit(1);
  }
  if (!stored) {
    console.log(`No keychain item found (service "${keychainService()}", account "${KEYCHAIN_ACCOUNT}").`);
    console.log("Run this script without --verify to create one.");
    process.exit(1);
  }
  console.log(`Stored credential keys (service "${keychainService()}"):`);
  for (const [key, value] of Object.entries(stored)) {
    console.log(`  ${key}: ${mask(value)}`);
  }
  process.exit(0);
}

// --- Setup mode ---
console.log("");
console.log("RAVEN Credential Setup (macOS Keychain)");
console.log("=======================================");
console.log("Credentials are stored in your login keychain, encrypted at rest and");
console.log("scoped to your macOS user account. Leave any prompt blank to keep the");
console.log("existing value (or skip an optional integration).");
console.log("");

// One readline interface for the whole session (see createPrompter's doc
// comment) — created before the existing-record read so it is also
// available for the overwrite confirmation below, if needed.
const prompter = createPrompter();

let existing;
try {
  existing = readKeychainRecord() ?? {};
} catch (err) {
  if (!(err instanceof KeychainReadError)) throw err;
  console.log("Existing keychain item could not be read — continuing will overwrite it.");
  const answer = await prompter.ask("Overwrite the unreadable keychain item? (yes/no)");
  if (answer.trim().toLowerCase() !== "yes") {
    prompter.close();
    process.exit(1);
  }
  existing = {};
}

// Same variables, sections, and order as setup-credentials.ps1.
const SECTIONS = [
  {
    header: null,
    fields: [
      ["ATLASSIAN_BASE_URL", "Atlassian base URL (e.g. https://apps.example.gov.bc.ca)", false],
      ["ATLASSIAN_EMAIL", "IDIR email (e.g. Jane.Smith@gov.bc.ca)", false],
      ["ATLASSIAN_PASSWORD", "IDIR password", true],
      ["SERVER_A_PASSWORD", "_A account password (leave blank to skip)", true],
    ],
  },
  {
    header: "Azure DevOps Server (leave blank to skip)",
    fields: [
      ["ADO_BASE_URL", "ADO base URL (e.g. https://ado.example.gov.bc.ca)", false],
      ["ADO_DEFAULT_COLLECTION", "ADO default collection (e.g. DefaultCollection)", false],
      ["ADO_PAT", "ADO Personal Access Token", true],
      ["ADO_DEFAULT_PROJECT", "ADO default project name (leave blank to skip)", false],
    ],
  },
  {
    header: "Jarvis API (leave blank to skip)",
    fields: [["JARVIS_TOKEN", "Jarvis Authorization Token", true]],
  },
  {
    header: "SonarQube (leave blank to skip)",
    fields: [
      ["SONARQUBE_URL", "SonarQube base URL (e.g. https://sonar.example.gov.bc.ca)", false],
      ["SONARQUBE_TOKEN", "SonarQube user token", true],
      ["SONAR_SCANNER_BIN", "SonarQube scanner binary path (e.g. /opt/sonar-scanner/bin/sonar-scanner)", false],
    ],
  },
  {
    header: "RFC Buddy (leave blank to skip)",
    fields: [
      ["RFCBUDDY_URL", "RFC Buddy base URL (e.g. https://rfcbuddy.example.com/api/v1/)", false],
      ["RFCBUDDY_PAT", "RFC Buddy Personal Access Token (PAT)", true],
    ],
  },
  {
    header: "Artifactory (leave blank to skip)",
    fields: [
      ["ARTIFACTORY_URL", "Internal Artifactory HTTPS base URL", false],
      ["ARTIFACTORY_EMAIL", "Artifactory IDIR email", false],
      ["ARTIFACTORY_PASSWORD", "Artifactory IDIR password", true],
    ],
  },
  {
    header: "Jenkins (leave blank to skip; API token is recommended for writes)",
    fields: [
      ["JENKINS_URL", "Jenkins HTTPS base URL (e.g. https://jenkins.example.gov.bc.ca/jenkins)", false],
      ["JENKINS_USER", "Jenkins username", false],
      ["JENKINS_TOKEN", "Jenkins API token", true],
      ["JENKINS_PASSWORD", "Jenkins password (leave blank when using an API token)", true],
    ],
  },
];

const promptedKeys = SECTIONS.flatMap((s) => s.fields.map(([name]) => name));
const envValues = readEnvFile();
// Blank answers keep these: keychain values first, then ~/.raven/.env values
// for prompted keys (first-run migration), plus keychain-only extras.
const defaults = seedDefaults(promptedKeys, envValues, existing);
const record = { ...defaults };

if (Object.keys(existing).length > 0) {
  console.log("Existing keychain credentials found - press Enter to keep each value.");
  console.log("");
}
if (promptedKeys.some((k) => !existing[k] && defaults[k])) {
  console.log("Values found in ~/.raven/.env will be imported for any prompt you leave blank.");
  console.log("");
}

for (const section of SECTIONS) {
  if (section.header) {
    console.log("");
    console.log(section.header);
  }
  for (const [name, label, sensitive] of section.fields) {
    const hint = existing[name] ? " [keep existing]" : defaults[name] ? " [import from .env]" : "";
    const answer = await prompter.ask(`${label}${hint}`, { sensitive });
    if (answer) record[name] = answer;
  }
}
prompter.close();

console.log("");

if (!record.ATLASSIAN_BASE_URL || !record.ATLASSIAN_EMAIL || !record.ATLASSIAN_PASSWORD) {
  console.error(
    "Error: ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD are required."
  );
  process.exit(1);
}

try {
  writeKeychainRecord(record);
} catch (err) {
  console.error(`Could not write to the login keychain (locked or access denied): ${err.message}`);
  process.exit(1);
}

console.log(`Credentials saved to the login keychain (service "${keychainService()}", account "${KEYCHAIN_ACCOUNT}").`);
console.log("");
console.log("Next steps:");
console.log("  - Remove the values now stored in the keychain from ~/.raven/.env —");
console.log("    the keychain is read first and .env remains a fallback.");
console.log("  - Run this script again with --verify to confirm the stored keys.");
