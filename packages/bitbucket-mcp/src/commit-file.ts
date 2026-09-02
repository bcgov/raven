import type { BitbucketClient } from "./bitbucket-client.js";

/** The subset of the client commit_file planning needs (mockable in tests). */
export type CommitFileLookups = Pick<BitbucketClient, "fileType" | "listBranches" | "listCommits">;

export interface CommitFileTarget {
  projectKey: string;
  repoSlug: string;
  filePath: string;
  branch: string;
  /** Commit the caller read the file at; required when the file exists. */
  sourceCommitId?: string;
}

/** Either write with this lock (or none, for a new file), or refuse with a reason. */
export type CommitFilePlan =
  | { ok: true; sourceCommitId?: string }
  | { ok: false; reason: string };

/**
 * Decide whether commit_file may write `filePath` on `branch`, and with which
 * optimistic lock. Pure orchestration over the client's read calls; the tool
 * handler renders the result and performs the write.
 *
 * - An explicit `sourceCommitId` is passed through untouched: the caller
 *   asserts which revision it read, and the server enforces it (409).
 * - A directory is refused.
 * - A branch that does not resolve is refused unless the repository has no
 *   branches at all, the empty-repository bootstrap create_repo advertises.
 * - An existing file without `sourceCommitId` is refused with the current
 *   tip, because a tip looked up here would only guard the lookup-to-write
 *   window, and an edit that landed between the caller's read_file and now
 *   would be silently overwritten.
 * - A path absent on an existing branch is a new file: no lock.
 */
export async function planCommitFile(
  bb: CommitFileLookups,
  t: CommitFileTarget
): Promise<CommitFilePlan> {
  if (t.sourceCommitId) return { ok: true, sourceCommitId: t.sourceCommitId };

  const type = await bb.fileType(t.projectKey, t.repoSlug, t.filePath, `refs/heads/${t.branch}`);
  if (type === "DIRECTORY") {
    return { ok: false, reason: `${t.filePath} is a directory on ${t.branch}; commit_file writes a single file.` };
  }
  if (type === "REF_MISSING") {
    const branches = await bb.listBranches(t.projectKey, t.repoSlug, 1);
    const example = branches.values[0]?.displayId;
    if (example !== undefined) {
      return {
        ok: false,
        reason: `Branch ${t.branch} does not exist in ${t.projectKey}/${t.repoSlug} (its branches include ${example}). commit_file never creates branches; create it with create_branch first, or check the name.`,
      };
    }
    return { ok: true }; // empty repository: first commit on a new branch
  }
  if (type === "FILE") {
    const commits = await bb.listCommits(t.projectKey, t.repoSlug, {
      path: t.filePath,
      until: `refs/heads/${t.branch}`,
      limit: 1,
    });
    const tip = commits.values[0]?.id ?? "unknown";
    return {
      ok: false,
      reason: `${t.filePath} already exists on ${t.branch} (latest commit ${tip}). Pass sourceCommitId, the commit read_file reported for this file, so an edit made since that read is detected instead of overwritten. Passing ${tip} asserts that the current content is what you intend to replace.`,
    };
  }
  return { ok: true }; // new file on an existing branch
}
