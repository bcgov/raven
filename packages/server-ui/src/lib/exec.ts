/**
 * Re-export execServerTool from server-mcp.
 *
 * Since server-mcp's shell-executor is a self-contained module, we
 * duplicate the logic here to avoid a hard dependency on the MCP package.
 * Both use the same CLI tools and authentication pattern.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

const execAsync = promisify(exec);

const BIN_DIR =
  process.env["SERVER_TOOLS_BIN"] ?? join(homedir(), "bin");

/**
 * Load a named variable from ~/.raven/.env.
 * Returns undefined if the file doesn't exist or the variable isn't found.
 */
function loadEnvVar(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;

  try {
    const envPath = join(homedir(), ".raven", ".env");
    const content = readFileSync(envPath, "utf-8");
    const re = new RegExp(`^${name}=(.+)$`, "m");
    const match = content.match(re);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/**
 * Load _A account password for SSH and sudo.
 * On BC Gov servers, sudo prompts for the calling user's (_A) password.
 */
function loadPassword(): string | undefined {
  return loadEnvVar("SERVER_A_PASSWORD");
}

/** Shell-escape a single argument. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a server CLI tool script.
 *
 * Uses exec (shell-based) because the underlying scripts call expect
 * which needs a proper shell context for PTY allocation.
 *
 * Passes SC_A_PASSWORD (SSH) and SC_PASSWORD (sudo) to the child process.
 * Neither password is ever logged or stored on disk.
 */
export async function execServerTool(
  script: string,
  args: string[],
  timeoutMs: number = 60_000
): Promise<ExecResult> {
  const scriptPath = join(BIN_DIR, script);
  const password = loadPassword();

  if (!password) {
    logger.error("SERVER_A_PASSWORD not set", { script });
    return {
      stdout: "",
      stderr: "SERVER_A_PASSWORD not set. Add it to ~/.raven/.env.",
      exitCode: 1,
    };
  }

  const cmdParts = [shellEscape(scriptPath), ...args.map(shellEscape)];
  const cmd = cmdParts.join(" ");
  const start = Date.now();

  logger.info(`exec: ${script}`, { args, cmd });

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      env: {
        ...process.env,
        SC_A_PASSWORD: password,
        SC_PASSWORD: password,
      },
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const duration = Date.now() - start;
    logger.info(`exec ok: ${script}`, {
      duration: `${duration}ms`,
      stdoutLen: stdout.length,
      stderrLen: stderr.length,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const duration = Date.now() - start;
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    logger.error(`exec fail: ${script}`, {
      duration: `${duration}ms`,
      exitCode: err.code,
      stderr: err.stderr?.slice(0, 500),
    });
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr || err.message || "Unknown error",
      exitCode: err.code ?? 1,
    };
  }
}
