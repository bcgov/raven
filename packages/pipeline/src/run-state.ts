import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CliArgs, PipelineContext } from "./types.js";

const RUNS_DIR = join(homedir(), ".raven", "runs");

/** Persistent state for a pipeline run. */
export interface RunState {
  id: string;
  startedAt: string;
  lastUpdated: string;
  args: CliArgs;
  /** Which step completed last (0 = not started, 1-6 = completed that step) */
  lastCompletedStep: number;
  context: PipelineContext;
  error?: string;
}

/** Build a run ID from app and component. */
export function buildRunId(app: string, component: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${app}-${component}-${date}`;
}

/** Load the most recent run state for this app/component, or null if none exists. */
export function loadRunState(app: string, component: string): RunState | null {
  if (!existsSync(RUNS_DIR)) return null;

  const prefix = `${app}-${component}-`;
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    const data = readFileSync(join(RUNS_DIR, files[0]!), "utf-8");
    return JSON.parse(data) as RunState;
  } catch {
    return null;
  }
}

/** Save run state to disk. */
export function saveRunState(state: RunState): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  state.lastUpdated = new Date().toISOString();
  writeFileSync(
    join(RUNS_DIR, `${state.id}.json`),
    JSON.stringify(state, (key, value) => {
      // Sets are transient (watch mode) — don't persist
      if (value instanceof Set) return undefined;
      return value;
    }, 2)
  );
}

/** Create a fresh RunState from CLI args and initial context. */
export function createRunState(args: CliArgs, ctx: PipelineContext): RunState {
  return {
    id: buildRunId(args.app, args.component),
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    args,
    lastCompletedStep: 0,
    context: ctx,
  };
}
