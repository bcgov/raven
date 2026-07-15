/**
 * Input validation for API parameters.
 *
 * Prevents shell injection by restricting server names to the
 * configured server list and app/component names to a safe character set.
 */
import { getServerNames } from "./server-config.js";

/** Validate and return server name, or null if invalid. */
export function validateServer(name: string | undefined): string | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  return getServerNames().includes(lower) ? lower : null;
}

/** Validate app or component name (alphanumeric, hyphens, underscores). */
export function validateAppName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** Validate search pattern (no shell metacharacters that could be dangerous). */
export function validatePattern(pattern: string): boolean {
  // Allow common grep patterns but reject shell injection attempts.
  // | (pipe) is allowed for grep -E alternation (e.g., "ERROR|FATAL").
  // It's safe because patterns are always single-quoted in the remote command.
  return pattern.length > 0 && pattern.length <= 200 && !/[;&`$]/.test(pattern);
}
