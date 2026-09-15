import { describe, it, expect, vi } from "vitest";
import { planCommitFile, type CommitFileLookups } from "../commit-file.js";

const T = { projectKey: "NRS", repoSlug: "repo", filePath: "conf/app.yaml", branch: "main" };
const TIP = "a".repeat(40);

function lookups(state: {
  type?: "FILE" | "DIRECTORY" | "REF_MISSING" | null;
  branches?: string[];
}): CommitFileLookups & { fileType: ReturnType<typeof vi.fn>; listBranches: ReturnType<typeof vi.fn>; listCommits: ReturnType<typeof vi.fn> } {
  return {
    fileType: vi.fn().mockResolvedValue(state.type ?? null),
    listBranches: vi.fn().mockResolvedValue({
      values: (state.branches ?? []).map((displayId) => ({ displayId, id: `refs/heads/${displayId}` })),
      isLastPage: true,
    }),
    listCommits: vi.fn().mockResolvedValue({ values: [{ id: TIP, displayId: TIP.slice(0, 11) }], isLastPage: true }),
  } as never;
}

describe("planCommitFile", () => {
  it("refuses a full ref or malformed branch name before any lookup", async () => {
    for (const branch of ["refs/heads/main", "", "-x", "a..b"]) {
      const bb = lookups({ type: "FILE" });
      const plan = await planCommitFile(bb, { ...T, branch, sourceCommitId: "b".repeat(40) });
      expect(plan).toMatchObject({ ok: false, reason: expect.stringMatching(/Refusing branch name/) });
      expect(bb.fileType).not.toHaveBeenCalled();
    }
  });

  it("passes an explicit sourceCommitId through without any lookup", async () => {
    const bb = lookups({ type: "FILE" });
    const plan = await planCommitFile(bb, { ...T, sourceCommitId: "b".repeat(40) });
    expect(plan).toEqual({ ok: true, sourceCommitId: "b".repeat(40) });
    expect(bb.fileType).not.toHaveBeenCalled();
  });

  it("looks the path up on the fully qualified branch ref", async () => {
    const bb = lookups({ type: null });
    await planCommitFile(bb, T);
    expect(bb.fileType).toHaveBeenCalledWith("NRS", "repo", "conf/app.yaml", "refs/heads/main");
  });

  it("allows a new file on an existing branch with no lock", async () => {
    const plan = await planCommitFile(lookups({ type: null }), T);
    expect(plan).toEqual({ ok: true });
  });

  it("refuses a directory", async () => {
    const plan = await planCommitFile(lookups({ type: "DIRECTORY" }), T);
    expect(plan).toMatchObject({ ok: false, reason: expect.stringMatching(/is a directory on main/) });
  });

  it("refuses a branch that does not exist when the repository has branches", async () => {
    const bb = lookups({ type: "REF_MISSING", branches: ["develop"] });
    const plan = await planCommitFile(bb, { ...T, branch: "release/3.4" });
    expect(plan).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Branch release\/3\.4 does not exist.*its branches include develop.*never creates branches/),
    });
    expect(bb.listBranches).toHaveBeenCalledWith("NRS", "repo", 1);
  });

  it("allows the first commit on an empty repository (no branches at all)", async () => {
    const plan = await planCommitFile(lookups({ type: "REF_MISSING", branches: [] }), T);
    expect(plan).toEqual({ ok: true });
  });

  it("refuses to update an existing file without sourceCommitId and names the current tip", async () => {
    const bb = lookups({ type: "FILE" });
    const plan = await planCommitFile(bb, T);
    expect(plan).toMatchObject({
      ok: false,
      reason: expect.stringMatching(new RegExp(`already exists on main \\(latest commit ${TIP}\\).*Pass sourceCommitId`)),
    });
    expect(bb.listCommits).toHaveBeenCalledWith("NRS", "repo", {
      path: "conf/app.yaml",
      until: "refs/heads/main",
      limit: 1,
    });
  });
});
