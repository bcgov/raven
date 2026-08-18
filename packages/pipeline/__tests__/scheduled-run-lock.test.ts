import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// scheduled-run.sh per-target lock (scripts/scheduled-run.sh)
//
// The mkdir lock keeps overlapping same-target invocations (cron, manual)
// off the same clone and state. A purely age-based stale reclaim steals the
// lock from a still-running pipeline after 2 hours — the dir's mtime is set
// at acquisition and never updated — so staleness must be judged by whether
// the recorded owner process is still alive.
// ---------------------------------------------------------------------------

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "scheduled-run.sh");

let workDir: string;
let markerFile: string;

/** Run the script with a stub pipeline binary; returns log text + marker state. */
function runScript(): { logs: string; pipelineRan: boolean; status: number } {
  const result = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: process.env["PATH"]!,
      HOME: workDir, // no ~/.raven/.env → pre-flight is skipped with a WARN
      RAVEN_REPO: join(workDir, "repo"),
      RAVEN_LOG_DIR: join(workDir, "logs"),
      PIPELINE_SERVER: "testserver",
      PIPELINE_APP: "TESTAPP",
      PIPELINE_COMPONENT: "testapp-api",
      MARKER_FILE: markerFile,
    },
    encoding: "utf8",
  });
  const logDir = join(workDir, "logs");
  const logs = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => readFileSync(join(logDir, f), "utf8"))
    .join("\n");
  return { logs, pipelineRan: existsSync(markerFile), status: result.status ?? -1 };
}

function lockDir(): string {
  return join(workDir, "logs", ".lock-testserver-TESTAPP-testapp-api");
}

/** Backdate the lock dir past the 2-hour age threshold. */
function backdateLock(): void {
  execFileSync("touch", ["-t", "202601010000", lockDir()]);
}

/** PID of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync("node", ["-e", "process.exit(0)"]);
  return child.pid!;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "raven-schedlock-"));
  markerFile = join(workDir, "pipeline-ran");
  mkdirSync(join(workDir, "logs"), { recursive: true });
  const stubDist = join(workDir, "repo", "packages", "pipeline", "dist");
  mkdirSync(stubDist, { recursive: true });
  writeFileSync(
    join(stubDist, "index.js"),
    'require("node:fs").writeFileSync(process.env.MARKER_FILE, "ran");\n',
  );
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("scheduled-run.sh lock", () => {
  it("runs the pipeline and releases the lock when uncontended", () => {
    const { logs, pipelineRan, status } = runScript();
    expect(status).toBe(0);
    expect(pipelineRan).toBe(true);
    expect(logs).toContain("DONE");
    expect(existsSync(lockDir())).toBe(false);
  });

  it("skips when a fresh lock is held", () => {
    mkdirSync(lockDir());
    const { logs, pipelineRan, status } = runScript();
    expect(status).toBe(0);
    expect(pipelineRan).toBe(false);
    expect(logs).toContain("SKIP");
    expect(existsSync(lockDir())).toBe(true); // never remove a held lock
  });

  it("does not steal an aged lock whose owner is still running", () => {
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "pid"), String(process.pid)); // this test process — alive
    backdateLock();
    const { logs, pipelineRan, status } = runScript();
    expect(status).toBe(0);
    expect(pipelineRan).toBe(false);
    // The skip must come from recognizing the live owner, not from a
    // failed reclaim attempt.
    expect(logs).toContain("lock held by PID");
    expect(existsSync(lockDir())).toBe(true);
  });

  it("reclaims a lock whose recorded owner is dead", () => {
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "pid"), String(deadPid())); // crashed run
    const { logs, pipelineRan, status } = runScript();
    expect(status).toBe(0);
    expect(pipelineRan).toBe(true);
    expect(logs).toContain("DONE");
    expect(existsSync(lockDir())).toBe(false);
  });

  it("reclaims an ownerless lock once it has aged past the acquire window", () => {
    mkdirSync(lockDir()); // crash between mkdir and pid write
    backdateLock();
    const { pipelineRan, status } = runScript();
    expect(status).toBe(0);
    expect(pipelineRan).toBe(true);
  });
});
