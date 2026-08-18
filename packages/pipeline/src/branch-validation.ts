/**
 * Practical validation for --branch values before they reach git checkout
 * argv and refs/heads/<name> PR targets. Implements the git ref-name rules
 * that matter for branch shorthands (see git-check-ref-format): rejects
 * option injection, HEAD, '..' sequences, empty / dot-leading / .lock
 * components, bad path boundaries, and ref-syntax metacharacters. Failing
 * here beats failing at IMPLEMENT, after a ticket already exists.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name === "HEAD") return false;
  // Charset excludes whitespace, ~ ^ : ? * [ \ @{ and control characters;
  // the leading [\w] rejects option injection and leading '/' '-' '.'.
  if (!/^[\w][\w./-]*$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.endsWith("/") || name.endsWith(".")) return false;
  return name
    .split("/")
    .every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".lock"));
}
