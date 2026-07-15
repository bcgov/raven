import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { sanitizeFilename } from "./attachment-content.js";

/**
 * Save attachment bytes to disk under destDir (default: process.cwd()).
 * The filename is sanitized to a safe basename; the write path is asserted
 * to stay inside destDir. Returns the absolute path written.
 */
export async function saveAttachment(
  bytes: Uint8Array,
  filename: string,
  destDir?: string
): Promise<string> {
  const dir = resolve(destDir ?? process.cwd());
  await mkdir(dir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const full = join(dir, safe);
  if (full !== dir && !full.startsWith(dir + sep)) {
    throw new Error(`Refusing to write outside ${dir}: ${filename}`);
  }
  await writeFile(full, bytes, { mode: 0o600 });
  return full;
}
