#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { git, repoRoot, validateCatalog } from "./release-lib.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

const values = process.argv.slice(2);
if (!values.includes("--confirm"))
  throw new Error(
    "Draft creation requires --confirm after release-environment approval.",
  );
function requiredValue(name) {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}
const directory = resolve(requiredValue("--directory"));
const commit = requiredValue("--commit").toLowerCase();
const notes = resolve(requiredValue("--notes"));
if (!/^[0-9a-f]{40}$/.test(commit ?? ""))
  throw new Error("A full source commit SHA is required.");

const catalog = validateCatalog();
const tag = `v${catalog.suiteVersion}`;
if (git("rev-parse", "HEAD").toLowerCase() !== commit)
  throw new Error("HEAD does not match the approved commit.");
if (git("rev-parse", "origin/main").toLowerCase() !== commit)
  throw new Error("origin/main does not match the approved commit.");
if (git("status", "--porcelain"))
  throw new Error("Draft creation requires a completely clean worktree.");
const notesRelative = relative(repoRoot, notes).split("\\").join("/");
if (
  !notesRelative ||
  notesRelative === ".." ||
  notesRelative.startsWith("../") ||
  isAbsolute(notesRelative)
) {
  throw new Error("Release notes must be inside the repository.");
}
run("git", ["ls-files", "--error-unmatch", "--", notesRelative]);
run(process.execPath, [
  join(repoRoot, "scripts", "release", "verify-release.mjs"),
  "--directory",
  directory,
  "--commit",
  commit,
]);

const existingRelease = spawnSync(
  "gh",
  ["release", "view", tag, "--repo", "bcgov/raven"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  },
);
if (existingRelease.status === 0)
  throw new Error(`GitHub release '${tag}' already exists.`);
if (
  existingRelease.error ||
  !/release not found|HTTP 404/i.test(
    `${existingRelease.stdout}\n${existingRelease.stderr}`,
  )
) {
  throw new Error(
    `Could not verify release absence: ${existingRelease.error?.message ?? existingRelease.stderr.trim()}`,
  );
}

const remoteTag = spawnSync(
  "git",
  [
    "-C",
    repoRoot,
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ],
  {
    encoding: "utf8",
    shell: false,
  },
);
if (remoteTag.status === 0) {
  run("git", ["fetch", "origin", `refs/tags/${tag}`]);
  if (
    git("cat-file", "-t", "FETCH_HEAD") !== "tag" ||
    git("rev-parse", "FETCH_HEAD^{}").toLowerCase() !== commit
  ) {
    throw new Error(
      `Existing remote tag '${tag}' is not an annotated tag for the approved commit.`,
    );
  }
} else if (remoteTag.status === 2) {
  run("git", ["tag", "-a", tag, "-m", `Raven ${tag}`, commit]);
  run("git", ["push", "origin", `refs/tags/${tag}`]);
} else {
  throw new Error(
    `Could not verify tag absence: ${remoteTag.error?.message ?? remoteTag.stderr.trim()}`,
  );
}

const assets = readdirSync(directory)
  .filter((name) => /\.(tar\.gz|manifest\.json|sbom\.spdx\.json)$/.test(name))
  .map((name) => join(directory, name));
if (assets.length !== catalog.supportedPlatforms.length * 3) {
  throw new Error(
    `Expected three assets per supported platform; found ${assets.length}.`,
  );
}
run("gh", [
  "release",
  "create",
  tag,
  ...assets,
  "--repo",
  "bcgov/raven",
  "--draft",
  "--verify-tag",
  "--title",
  `BCGov Raven - ${tag}`,
  "--notes-file",
  notes,
  "--fail-on-no-commits",
]);
const release = JSON.parse(
  run("gh", [
    "release",
    "view",
    tag,
    "--repo",
    "bcgov/raven",
    "--json",
    "isDraft,tagName,targetCommitish,assets",
  ]),
);
const uploadedNames = new Set(
  (release.assets ?? []).map((asset) => asset.name),
);
if (
  release.isDraft !== true ||
  release.tagName !== tag ||
  assets.some((asset) => !uploadedNames.has(asset.split(/[\\/]/).at(-1)))
) {
  throw new Error(`Draft release '${tag}' failed post-creation verification.`);
}
console.log(`Created draft release ${tag} from ${commit}.`);
