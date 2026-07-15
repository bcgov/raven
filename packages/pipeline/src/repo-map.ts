import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REPO_MAP_PATH = join(homedir(), ".raven", "repo-map.json");

/** Cached mapping from app/component to its Bitbucket project and repo. */
export interface RepoMapping {
  bitbucketProject: string;
  bitbucketRepo: string;
  discoveredAt: string;
}

type RepoMap = Record<string, RepoMapping>;

/** Load the repo map from disk. */
export function loadRepoMap(): RepoMap {
  if (!existsSync(REPO_MAP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REPO_MAP_PATH, "utf-8")) as RepoMap;
  } catch {
    return {};
  }
}

/** Save the repo map to disk, creating ~/.raven on first use if needed. */
export function saveRepoMap(map: RepoMap): void {
  mkdirSync(dirname(REPO_MAP_PATH), { recursive: true });
  writeFileSync(REPO_MAP_PATH, JSON.stringify(map, null, 2));
}

/** Get the cached mapping for an app/component, or null if not cached. */
export function getMapping(app: string, component: string): RepoMapping | null {
  const map = loadRepoMap();
  return map[`${app}/${component}`] ?? null;
}

/** Save a mapping for an app/component. */
export function setMapping(app: string, component: string, mapping: RepoMapping): void {
  const map = loadRepoMap();
  map[`${app}/${component}`] = mapping;
  saveRepoMap(map);
}
