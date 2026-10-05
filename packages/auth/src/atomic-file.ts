import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 25;

/** errno values Windows reports when another process has the destination open while it is renamed over. */
const WINDOWS_TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Write `contents` to `path` so a concurrent reader sees the old file or the
 * new one, never a truncated or partial file.
 *
 * The data goes to a uniquely named sibling temp file (mode 0600) that is then
 * renamed into place; rename replaces the destination atomically on one
 * filesystem. On Windows, renaming over a file that another process has open
 * can fail transiently (EPERM/EBUSY/EACCES), so those errors are retried
 * briefly; elsewhere they are real permission errors and fail immediately.
 * The temp file is removed if the write or the rename fails, leaving any
 * existing file untouched. The parent directory is created (0700) if needed.
 * The mode bits are POSIX permissions and have no effect on Windows.
 *
 * @param path - Destination file.
 * @param contents - UTF-8 text to write.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, contents, { encoding: "utf-8", mode: 0o600 });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(tmpPath, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const transient = process.platform === "win32" && code !== undefined && WINDOWS_TRANSIENT_CODES.has(code);
        if (!transient || attempt >= RENAME_ATTEMPTS) throw err;
        await sleep(RENAME_RETRY_MS * attempt);
      }
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
