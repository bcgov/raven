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

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  encodeKeychainBlob,
  decodeKeychainBlob,
} from "../packages/auth/dist/load-env.js";

const SERVICE = process.env.RAVEN_KEYCHAIN_SERVICE || "raven";
const ACCOUNT = "credentials";

function readStoredRecord() {
  try {
    const blob = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return decodeKeychainBlob(blob);
  } catch {
    return null;
  }
}

function writeStoredRecord(record) {
  const blob = encodeKeychainBlob(record);
  // security's interactive mode (-i) keeps the blob out of the process
  // argument list, where any same-user process could momentarily see it.
  execFileSync("/usr/bin/security", ["-i"], {
    input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${blob}\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

function mask(value) {
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

/** Prompt on the terminal; sensitive values are read with echo suppressed. */
function prompt(question, { sensitive = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (sensitive) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => {
        // Echo the prompt itself but not the typed characters.
        if (s.includes(question)) write(s);
      };
    }
    rl.question(`${question}: `, (answer) => {
      rl.close();
      if (sensitive) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// --- Verify mode ---
if (process.argv.includes("--verify")) {
  const stored = readStoredRecord();
  if (!stored) {
    console.log(`No keychain item found (service "${SERVICE}", account "${ACCOUNT}").`);
    console.log("Run this script without --verify to create one.");
    process.exit(1);
  }
  console.log(`Stored credential keys (service "${SERVICE}"):`);
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

const existing = readStoredRecord() ?? {};
if (Object.keys(existing).length > 0) {
  console.log("Existing keychain credentials found - press Enter to keep each value.");
  console.log("");
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

const record = { ...existing }; // carry forward extra keys (e.g. IMIS_CSV_PATH)

for (const section of SECTIONS) {
  if (section.header) {
    console.log("");
    console.log(section.header);
  }
  for (const [name, label, sensitive] of section.fields) {
    const hint = existing[name] ? " [keep existing]" : "";
    const answer = await prompt(`${label}${hint}`, { sensitive });
    if (answer) record[name] = answer;
  }
}

console.log("");

if (!record.ATLASSIAN_BASE_URL || !record.ATLASSIAN_EMAIL || !record.ATLASSIAN_PASSWORD) {
  console.error(
    "Error: ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD are required."
  );
  process.exit(1);
}

writeStoredRecord(record);

console.log(`Credentials saved to the login keychain (service "${SERVICE}", account "${ACCOUNT}").`);
console.log("");
console.log("Next steps:");
console.log("  - Remove the values now stored in the keychain from ~/.raven/.env —");
console.log("    the keychain is read first and .env remains a fallback.");
console.log("  - Run this script again with --verify to confirm the stored keys.");
