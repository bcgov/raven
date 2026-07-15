import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionManager, createAuthenticatedFetch, createBasicAuthFetch, PiScrubber, authCliPath } from "@nrs/auth";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));
import {
  BitbucketClient,
  CodeSearchNotAvailableError,
} from "./bitbucket-client.js";

const MAX_FILE_CHARS = 10000;

/**
 * Create and configure the Bitbucket MCP server.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createBitbucketServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Bitbucket",
      version: "0.1.0",
    },
    {
      instructions: `You have access to tools for browsing Bitbucket repositories, reading files, viewing/reviewing pull requests, exploring commit history, blaming files, listing tags, and reading CI build status. Read tools (list_repos, browse_files, list_all_files, read_file, list_branches, list_pull_requests, read_pull_request, clone_repo, search_code, get_pr_diff, list_pr_comments, list_pr_commits, list_commits, get_commit, blame_file, list_tags, get_tag, get_build_status) let you browse and review. Write tools (create_branch, create_pull_request, add_pr_comment, review_pr, merge_pr, decline_pr, create_tag) let you act on the repo. IMPORTANT: You MUST use the write tools when the user asks you to perform these actions. Never refuse by claiming these tools are read-only — they are not. However, always confirm with the user before calling write tools, since these actions modify live Bitbucket content. merge_pr, decline_pr, and create_tag are especially visible/destructive — never invoke without explicit user confirmation. Keep API calls to a minimum: call list_branches first to find the newest release or feature branch, then browse or read files on that branch, then summarize for the user. After that flow, STOP calling tools. Never call the same tool twice with the same arguments.

IMPORTANT — Bitbucket project keys often differ from Jira project keys. If a project key returns a 404 "does not exist" error, try common variations before giving up:
- The Jira key itself (e.g., "RRS")
- Prefixed with "NR-" or "NRS-" (e.g., "NR-RRS")
- The repo may live under a broader project — try searching with search_code or ask the user
- Try at least 3 different key variations before asking the user

If you encounter authentication errors (401 Unauthorized or "No valid SMSESSION found"), inform the user they need to set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD environment variables for Basic Auth, or re-authenticate via SMSESSION by running: node ${authCliPath}${WORKAROUND_NOTE}`,
    }
  );

  let client: BitbucketClient | null = null;
  let sessionManager: SessionManager | null = null;
  let usingBasicAuth = false;

  async function getClient(): Promise<BitbucketClient> {
    if (!client) {
      const email = process.env["ATLASSIAN_EMAIL"];
      const password = process.env["ATLASSIAN_PASSWORD"];
      const baseUrl = process.env["ATLASSIAN_BASE_URL"];

      if (email && password && baseUrl) {
        const authFetch = createBasicAuthFetch(email, password);
        client = new BitbucketClient(authFetch, `${baseUrl}/int/stash`);
        usingBasicAuth = true;
      } else {
        sessionManager = new SessionManager();
        const authFetch = await createAuthenticatedFetch(sessionManager);
        client = new BitbucketClient(authFetch);
      }
    }
    return client;
  }

  async function getSessionManager(): Promise<SessionManager> {
    if (!sessionManager) {
      await getClient(); // initializes sessionManager
    }
    return sessionManager!;
  }

  // --- Tools ---

  server.tool(
    "list_repos",
    `List repositories in a Bitbucket project. Returns repo names, slugs, and descriptions.

IMPORTANT: Bitbucket project keys often differ from Jira keys. If a key returns 404 "does not exist", try variations: the app acronym itself (e.g., "CWM"), prefixed forms ("NR-CWM"), or broader project keys. Try at least 3 variations before giving up.`,
    {
      projectKey: z
        .string()
        .describe(
          "Bitbucket project key (e.g., DEMO, FOIPPA, CWM). Usually uppercase. NOTE: may differ from Jira project key."
        ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(25)
        .describe("Maximum repos to return (1-50, default 25)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, limit }) => {
      try {
        const bb = await getClient();
        const result = await bb.listRepos(projectKey, limit);

        if (result.values.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No repositories found in project '${projectKey}'.`,
              },
            ],
          };
        }

        const lines = result.values.map((repo) => {
          let line = `- **${repo.name}** (slug: ${repo.slug})`;
          if (repo.description) line += `\n  ${repo.description}`;
          return line;
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Found ${result.size} repos in project '${projectKey}':\n\n` +
                lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing repos: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "browse_files",
    "Browse files and directories in a Bitbucket repository. Returns a listing of files and subdirectories at the specified path.\n\nIMPORTANT: Always search the newest release branch (e.g., release/*) or a feature branch if available, rather than the default branch. Use list_branches first to find the most recent branch. Always include the branch name and file path when referencing results to the user.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      path: z
        .string()
        .default("")
        .describe("Path within the repo (empty for root)"),
      at: z
        .string()
        .optional()
        .describe("Branch or commit to browse (defaults to default branch)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, path, at }) => {
      try {
        const bb = await getClient();
        const result = await bb.browseFiles(projectKey, repoSlug, path, at);

        const entries = result.children?.values ?? [];
        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files found at ${projectKey}/${repoSlug}/${path || "/"}`,
              },
            ],
          };
        }

        const lines = entries.map((entry) => {
          const icon = entry.type === "DIRECTORY" ? "dir" : "file";
          const size =
            entry.type === "FILE" && entry.size
              ? ` (${entry.size} bytes)`
              : "";
          return `  ${icon}  ${entry.path.toString}${size}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                `${projectKey}/${repoSlug}/${path || "/"} (branch: ${at ?? "default"}):\n\n` +
                lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error browsing files: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "read_file",
    "Read the content of a file from a Bitbucket repository. Returns the raw file content.\n\nIMPORTANT: Always search the newest release branch (e.g., release/*) or a feature branch if available, rather than the default branch. Use list_branches first to find the most recent branch. Always include the branch name and file path when referencing results to the user.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      filePath: z.string().describe("Path to the file within the repo"),
      at: z
        .string()
        .optional()
        .describe("Branch or commit (defaults to default branch)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, filePath, at }) => {
      try {
        const bb = await getClient();
        let content = await bb.readFile(projectKey, repoSlug, filePath, at);

        if (content.length > MAX_FILE_CHARS) {
          content =
            content.slice(0, MAX_FILE_CHARS) +
            `\n\n... [TRUNCATED at ${MAX_FILE_CHARS} chars, file is ${content.length} chars total]`;
        }

        return {
          content: [
            {
              type: "text",
              text: `### ${filePath}\n**Repo:** ${projectKey}/${repoSlug} | **Branch:** ${at ?? "default"}\n\`\`\`\n${content}\n\`\`\``,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_all_files",
    "List every file path in a Bitbucket repository (flat, recursive). Pages through results until done. Use this to enumerate a repo's contents — e.g. to find all *.java files — without cloning.\n\nReturns full paths from repo root. Capped to avoid context overflow; raise maxFiles for large monorepos.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      maxFiles: z
        .number()
        .min(1)
        .max(50000)
        .default(1000)
        .describe("Hard cap on files returned (default 1000, max 50000)"),
      filter: z
        .string()
        .optional()
        .describe("Optional substring or extension filter applied client-side (e.g., '.java', 'src/main/')"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, maxFiles, filter }) => {
      try {
        const bb = await getClient();
        // Cap the page size at maxFiles so small requests (e.g., maxFiles=100)
        // don't pull a full 5000-row page just to truncate it client-side.
        const pageSize = Math.min(5000, maxFiles);
        const all = await bb.listFiles(projectKey, repoSlug, pageSize, maxFiles);
        const filtered = filter ? all.filter((f) => f.includes(filter)) : all;

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: filter
                  ? `No files matching '${filter}' in ${projectKey}/${repoSlug} (${all.length} total files scanned).`
                  : `No files found in ${projectKey}/${repoSlug}.`,
              },
            ],
          };
        }

        const header = filter
          ? `${filtered.length} files matching '${filter}' (of ${all.length} scanned, cap ${maxFiles}):`
          : `${filtered.length} files in ${projectKey}/${repoSlug} (cap ${maxFiles}):`;

        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${filtered.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing files: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_branches",
    "List branches in a Bitbucket repository. Shows branch names and latest commit. Use this to identify the newest release or feature branch before browsing or reading files.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug }) => {
      try {
        const bb = await getClient();
        const result = await bb.listBranches(projectKey, repoSlug);

        if (result.values.length === 0) {
          return {
            content: [
              { type: "text", text: "No branches found." },
            ],
          };
        }

        const lines = result.values.map((branch) => {
          const defaultTag = branch.isDefault ? " (default)" : "";
          return `- **${branch.displayId}**${defaultTag} - ${branch.latestCommit.slice(0, 8)}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Branches in ${projectKey}/${repoSlug}:\n\n` +
                lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing branches: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_pull_requests",
    "List pull requests for a Bitbucket repository. Shows PR title, author, and status.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      state: z
        .enum(["OPEN", "MERGED", "DECLINED", "ALL"])
        .default("OPEN")
        .describe("PR state filter"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, state }) => {
      try {
        const bb = await getClient();
        const result = await bb.listPullRequests(
          projectKey,
          repoSlug,
          state
        );

        if (result.values.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No ${state.toLowerCase()} pull requests found.`,
              },
            ],
          };
        }

        const lines = result.values.map((pr) => {
          const date = new Date(pr.createdDate).toISOString().split("T")[0];
          return (
            `- **#${pr.id}: ${pr.title}** [${pr.state}]\n` +
            `  ${pr.fromRef.displayId} → ${pr.toRef.displayId} | Author: ${pi.scrub(pr.author.user.displayName)} | ${date}`
          );
        });

        return {
          content: [
            {
              type: "text",
              text:
                `${result.size} pull requests (${state}):\n\n` +
                lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing PRs: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "read_pull_request",
    "Read full details of a pull request including description, reviewers, and branch info.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, prId }) => {
      try {
        const bb = await getClient();
        const pr = await bb.getPullRequest(projectKey, repoSlug, prId);

        const lines: string[] = [];
        lines.push(`## PR #${pr.id}: ${pr.title}`);
        lines.push(`**State:** ${pr.state}`);
        lines.push(`**Author:** ${pi.scrub(pr.author.user.displayName)}`);
        lines.push(
          `**Branch:** ${pr.fromRef.displayId} → ${pr.toRef.displayId}`
        );
        lines.push(
          `**Created:** ${new Date(pr.createdDate).toISOString().split("T")[0]}`
        );

        if (pr.reviewers.length > 0) {
          const reviewerList = pr.reviewers
            .map(
              (r) =>
                `${pi.scrub(r.user.displayName)} (${r.approved ? "approved" : "pending"})`
            )
            .join(", ");
          lines.push(`**Reviewers:** ${reviewerList}`);
        }

        if (pr.description) {
          lines.push("");
          lines.push("### Description");
          lines.push(pr.description);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading PR: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "clone_repo",
    "Clone a Bitbucket repository locally for code analysis. Uses shallow clone by default. Read-only - no push operations.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      targetDir: z
        .string()
        .optional()
        .describe(
          "Directory to clone into (defaults to ~/Projects/<repoSlug>)"
        ),
      shallow: z
        .boolean()
        .default(true)
        .describe("Use shallow clone (--depth=1) for faster download"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, targetDir, shallow }) => {
      try {
        const bb = await getClient();

        const dest =
          targetDir ?? join(homedir(), "Projects", repoSlug);

        // Check if already cloned
        if (existsSync(join(dest, ".git"))) {
          return {
            content: [
              {
                type: "text",
                text: `Repository already cloned at ${dest}. Use 'git pull' to update.`,
              },
            ],
          };
        }

        // Check disk space (warn if < 500MB)
        try {
          const stats = statfsSync(join(homedir(), "Projects"));
          const freeGB = (stats.bfree * stats.bsize) / (1024 * 1024 * 1024);
          if (freeGB < 0.5) {
            return {
              content: [
                {
                  type: "text",
                  text: `Low disk space (${freeGB.toFixed(1)}GB free). Clone aborted.`,
                },
              ],
              isError: true,
            };
          }
        } catch {
          // Skip disk check if unsupported
        }

        const cloneUrl = bb.getCloneUrl(projectKey, repoSlug);

        // Build auth header for git clone based on active auth method
        let authHeader: string;
        if (usingBasicAuth) {
          const email = process.env["ATLASSIAN_EMAIL"]!;
          const password = process.env["ATLASSIAN_PASSWORD"]!;
          const credentials = btoa(`${email}:${password}`);
          authHeader = `Authorization: Basic ${credentials}`;
        } else {
          const sm = await getSessionManager();
          const cookie = await sm.getSession();
          authHeader = `Cookie: SMSESSION=${cookie}`;
        }

        const args = [
          "clone",
          "-c",
          `http.extraHeader=${authHeader}`,
        ];
        if (shallow) args.push("--depth=1");
        args.push(cloneUrl, dest);

        execFileSync("git", args, {
          encoding: "utf-8",
          timeout: 300_000, // 5 minutes
          stdio: ["ignore", "pipe", "pipe"],
        });

        return {
          content: [
            {
              type: "text",
              text: `Repository cloned to ${dest}${shallow ? " (shallow)" : ""}.\nYou can now analyze the code at this path.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Clone failed: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search_code",
    `Search code across Bitbucket repositories using the Code Search plugin. Returns matching files with context lines around each match.

IMPORTANT LIMITATION: Code search only indexes the DEFAULT BRANCH of each repository. Many BC Gov repos use release branches (e.g., release/3.3.0) as their active branch, so code on non-default branches will NOT appear in search results. If search returns no results but you know the code exists, use clone_repo to clone the repository and search locally, or use browse_files/read_file on the correct branch.

Supports Elasticsearch-style query syntax:
- Simple text: "createAuthenticatedFetch"
- Exact phrase: "function handleError"
- File extension: "ext:ts createServer"
- Path filter: "path:src/main query"
- Boolean: "SessionManager AND cookie"

IMPORTANT: Always include the file path and repository when referencing results to the user.`,
    {
      query: z
        .string()
        .describe(
          "Search query (supports Elasticsearch syntax: ext:ts, path:src/, AND/OR, exact phrases in quotes)"
        ),
      projectKey: z
        .string()
        .optional()
        .describe(
          "Bitbucket project key to scope search (e.g., NRS, FOIPPA)"
        ),
      repoSlug: z
        .string()
        .optional()
        .describe(
          "Repository slug to scope search (requires projectKey)"
        ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(25)
        .describe("Maximum results to return (1-50, default 25)"),
    },
    { readOnlyHint: true },
    async ({ query, projectKey, repoSlug, limit }) => {
      try {
        const bb = await getClient();
        const results = await bb.searchCode(
          query,
          projectKey,
          repoSlug,
          limit
        );

        const codeResults = results.code;
        if (!codeResults || codeResults.values.length === 0) {
          const scope = projectKey
            ? repoSlug
              ? ` in ${projectKey}/${repoSlug}`
              : ` in project ${projectKey}`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `No code matches found for: ${query}${scope}\n\nNote: Code search only indexes the default branch (usually main/master). If the code lives on a release or feature branch, use clone_repo to clone the repository and search locally, or use browse_files/read_file on the correct branch.`,
              },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(
          `Found ${codeResults.count} code matches (showing ${codeResults.values.length}):\n`
        );

        for (const result of codeResults.values) {
          const repoInfo = `${result.repository.project.key}/${result.repository.slug}`;

          lines.push(`### ${result.file}`);
          lines.push(`**Repo:** ${repoInfo}`);

          // Show context lines for each hit group (up to 3)
          if (result.hitContexts.length > 0) {
            for (const ctx of result.hitContexts.slice(0, 3)) {
              lines.push("```");
              for (const line of ctx) {
                // <em> tags indicate matched text in the API response
                const isMatch = line.text.includes("<em>");
                const cleanText = line.text
                  .replace(/<em>/g, "")
                  .replace(/<\/em>/g, "");
                const marker = isMatch ? ">>>" : "   ";
                lines.push(`${marker} ${line.line}: ${cleanText}`);
              }
              lines.push("```");
            }
            if (result.hitContexts.length > 3) {
              lines.push(
                `... and ${result.hitContexts.length - 3} more match contexts`
              );
            }
          }

          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        if (err instanceof CodeSearchNotAvailableError) {
          return {
            content: [{ type: "text", text: pi.scrubText(err.message) }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Error searching code: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_pull_request",
    "Create a pull request in a Bitbucket repository. Returns the created PR details including ID and URL.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      title: z.string().describe("PR title"),
      description: z.string().optional().describe("PR description (markdown supported)"),
      fromBranch: z.string().describe("Source branch name"),
      toBranch: z.string().default("main").describe("Target branch name (default: main)"),
      reviewers: z
        .array(z.string())
        .optional()
        .describe("Reviewer usernames (Bitbucket user slugs)"),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, title, description, fromBranch, toBranch, reviewers }) => {
      try {
        const bb = await getClient();
        const pr = await bb.createPullRequest(projectKey, repoSlug, {
          title,
          description,
          fromBranch,
          toBranch,
          reviewers,
        });

        const lines: string[] = [];
        lines.push(`Pull request created successfully.`);
        lines.push("");
        lines.push(`**PR #${pr.id}: ${pr.title}**`);
        lines.push(`**Branch:** ${pr.fromRef.displayId} → ${pr.toRef.displayId}`);
        lines.push(`**State:** ${pr.state}`);
        if (pr.links?.self?.[0]?.href) {
          lines.push(`**URL:** ${pr.links.self[0].href}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating PR: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Pull request review tools
  // ---------------------------------------------------------------------------

  server.tool(
    "get_pr_diff",
    "Read the unified diff for a pull request — what files changed and how. Returns plain-text unified diff format. Use this to review the code changes before commenting/approving.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
      contextLines: z
        .number()
        .min(0)
        .max(50)
        .default(10)
        .describe("Lines of context around each change (default 10)"),
      maxChars: z
        .number()
        .min(1000)
        .max(200_000)
        .default(50_000)
        .describe("Truncation cap to avoid context overflow on huge PRs (default 50000)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, prId, contextLines, maxChars }) => {
      try {
        const bb = await getClient();
        let diff = await bb.getPullRequestDiff(projectKey, repoSlug, prId, contextLines);
        const truncated = diff.length > maxChars;
        if (truncated) {
          diff = diff.slice(0, maxChars) + `\n\n... [TRUNCATED at ${maxChars} chars; full diff is ${diff.length} chars]`;
        }
        return {
          content: [
            {
              type: "text",
              text: `### Diff for PR #${prId} (${projectKey}/${repoSlug})\n\n\`\`\`diff\n${diff}\n\`\`\``,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching diff: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_pr_comments",
    "List comments on a pull request — both general PR comments and inline file/line comments — by walking the activity stream and filtering for COMMENTED activities. Includes author, date, anchor (file/line for inline), and the comment text.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
      maxEntries: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum activity entries to scan for comments (default 100)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, prId, maxEntries }) => {
      try {
        const bb = await getClient();
        const activities = await bb.getPullRequestActivities(projectKey, repoSlug, prId, maxEntries);
        const comments = activities.filter((a) => a.action === "COMMENTED" && a.comment);
        if (comments.length === 0) {
          return {
            content: [
              { type: "text", text: `No comments on PR #${prId}.` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`### ${comments.length} comment(s) on PR #${prId}`);
        for (const a of comments) {
          const c = a.comment!;
          const date = new Date(c.createdDate).toISOString().split("T")[0];
          const author = pi.scrub(c.author.displayName) ?? "Unknown";
          const anchor = c.anchor
            ? ` _(inline: ${c.anchor.path}${c.anchor.line ? `:${c.anchor.line}` : ""})_`
            : "";
          lines.push(`\n**${author}** (${date})${anchor}:`);
          lines.push(pi.scrubText(c.text));
          if (c.comments && c.comments.length > 0) {
            for (const reply of c.comments) {
              const rDate = new Date(reply.createdDate).toISOString().split("T")[0];
              const rAuthor = pi.scrub(reply.author.displayName) ?? "Unknown";
              lines.push(`  ↳ **${rAuthor}** (${rDate}): ${pi.scrubText(reply.text)}`);
            }
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing PR comments: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "add_pr_comment",
    "Add a comment to a pull request. Omit `path` for a general PR comment; provide `path` (and optionally `line` + `lineType`) for an inline file/line comment.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
      text: z.string().describe("Comment body (Markdown supported in Bitbucket DC)"),
      path: z
        .string()
        .optional()
        .describe("File path within the repo for an inline comment. Omit for a general PR comment."),
      line: z
        .number()
        .optional()
        .describe("Line number for inline comment (1-based)"),
      lineType: z
        .enum(["ADDED", "REMOVED", "CONTEXT"])
        .optional()
        .describe("ADDED for green/new lines, REMOVED for red/deleted, CONTEXT for unchanged. Default ADDED if line is set."),
      fileType: z
        .enum(["FROM", "TO"])
        .optional()
        .describe("FROM = source side of the diff, TO = target side. Default TO if line is set."),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, prId, text, path, line, lineType, fileType }) => {
      try {
        // Fail loudly if the caller passed any inline-only field without a
        // path — silently downgrading to a general comment would discard
        // their inline intent and surprise them. line=1 is intentional and
        // valid for an inline anchor at the first line, so check explicit
        // undefined.
        if (!path && (line !== undefined || lineType !== undefined || fileType !== undefined)) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Error: `path` is required when `line`, `lineType`, or `fileType` is provided. " +
                  "These fields only make sense on inline comments anchored to a file. " +
                  "Either supply `path` for an inline comment, or omit all of line/lineType/fileType for a general PR comment.",
              },
            ],
            isError: true,
          };
        }

        const bb = await getClient();
        const anchor = path
          ? {
              path,
              line,
              lineType: lineType ?? (line !== undefined ? "ADDED" as const : undefined),
              fileType: fileType ?? (line !== undefined ? "TO" as const : undefined),
            }
          : undefined;
        const comment = await bb.addPullRequestComment(projectKey, repoSlug, prId, text, anchor);
        const desc = anchor ? `inline comment on ${anchor.path}${anchor.line ? `:${anchor.line}` : ""}` : "general PR comment";
        return {
          content: [
            {
              type: "text",
              text: `Posted ${desc} on PR #${prId} (comment id ${comment.id}).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error adding PR comment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_pr_commits",
    "List the commits in a pull request — what's actually being merged. Useful before approving to confirm the commit history matches the PR description.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum commits to return (default 100)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, prId, limit }) => {
      try {
        const bb = await getClient();
        const result = await bb.getPullRequestCommits(projectKey, repoSlug, prId, limit);
        if (result.values.length === 0) {
          return {
            content: [{ type: "text", text: `No commits found in PR #${prId}.` }],
          };
        }
        const lines = result.values.map((c) => {
          const date = new Date(c.authorTimestamp).toISOString().split("T")[0];
          const subject = c.message.split("\n")[0];
          return `- **${c.displayId}** ${date} ${pi.scrub(c.author.name) ?? "Unknown"}: ${pi.scrubText(subject)}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `### ${result.size} commit(s) in PR #${prId}\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing PR commits: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "review_pr",
    "Set your review status on a pull request: APPROVED, NEEDS_WORK, or UNAPPROVED (resets your review). This sets the participant status as the authenticated user.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
      status: z
        .enum(["APPROVED", "NEEDS_WORK", "UNAPPROVED"])
        .describe("Review status to set: APPROVED, NEEDS_WORK, or UNAPPROVED"),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, prId, status }) => {
      try {
        const bb = await getClient();
        await bb.setPullRequestStatus(projectKey, repoSlug, prId, status);
        return {
          content: [{ type: "text", text: `PR #${prId} review status set to ${status}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error setting review status: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "merge_pr",
    "Merge a pull request. Will fail if the PR has conflicts, missing approvals, or is already merged/declined. Always confirm with the user before merging — this is a destructive operation that updates the target branch.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, prId }) => {
      try {
        const bb = await getClient();
        // Fetch current PR for its version (optimistic-locking)
        const pr = await bb.getPullRequest(projectKey, repoSlug, prId);
        if (pr.version === undefined) {
          return {
            content: [{ type: "text", text: `Cannot merge PR #${prId}: server did not return a version field.` }],
            isError: true,
          };
        }
        // Pre-check mergeability so we surface vetoes clearly instead of a generic 409
        const status = await bb.canMergePullRequest(projectKey, repoSlug, prId);
        if (!status.canMerge) {
          const reasons = status.vetoes.map((v) => `- ${v.summaryMessage}`).join("\n");
          return {
            content: [
              {
                type: "text",
                text: `PR #${prId} cannot be merged${status.conflicted ? " (conflicted)" : ""}:\n${reasons || "(no veto details returned)"}`,
              },
            ],
            isError: true,
          };
        }
        const merged = await bb.mergePullRequest(projectKey, repoSlug, prId, pr.version);
        return {
          content: [
            {
              type: "text",
              text: `PR #${prId} merged. New state: ${merged.state}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error merging PR: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "decline_pr",
    "Decline (close without merging) a pull request. Always confirm with the user before declining.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      prId: z.number().describe("Pull request ID"),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, prId }) => {
      try {
        const bb = await getClient();
        const pr = await bb.getPullRequest(projectKey, repoSlug, prId);
        if (pr.version === undefined) {
          return {
            content: [{ type: "text", text: `Cannot decline PR #${prId}: server did not return a version field.` }],
            isError: true,
          };
        }
        const declined = await bb.declinePullRequest(projectKey, repoSlug, prId, pr.version);
        return {
          content: [
            {
              type: "text",
              text: `PR #${prId} declined. New state: ${declined.state}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error declining PR: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_branch",
    "Create a new branch in a Bitbucket repository from a starting point (branch name or commit hash).",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      branchName: z.string().describe("New branch name (e.g., bugfix/RRS-123-fix-null-pointer)"),
      startPoint: z.string().default("main").describe("Starting point — branch name or commit hash (default: main)"),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, branchName, startPoint }) => {
      try {
        const bb = await getClient();
        const branch = await bb.createBranch(projectKey, repoSlug, branchName, startPoint);

        return {
          content: [
            {
              type: "text",
              text: `Branch created successfully.\n\n**Branch:** ${branch.displayId}\n**Latest Commit:** ${branch.latestCommit}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating branch: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Commits / history / blame
  // ---------------------------------------------------------------------------

  server.tool(
    "list_commits",
    `List commits in a Bitbucket repository. Filter by branch (until/since), file path (for file history), or merge inclusion. Pages results.

Tips:
- For "show me the recent history of file X", set path=X and leave until/since unset.
- For "what's on release/3.2 that's not on main yet", set until=release/3.2 since=main.
- For just merge commits set merges='only'; to skip them set merges='exclude'.`,
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      until: z
        .string()
        .optional()
        .describe("Branch, tag, or commit to log from (defaults to default branch HEAD)"),
      since: z
        .string()
        .optional()
        .describe("Branch, tag, or commit to log to (exclusive). Useful for branch comparisons."),
      path: z
        .string()
        .optional()
        .describe("File path to filter to — gives the commit history for that file"),
      merges: z
        .enum(["include", "exclude", "only"])
        .optional()
        .describe("Merge commit handling (default: include)"),
      limit: z.number().min(1).max(100).default(25).describe("Page size (default 25)"),
      start: z.number().min(0).default(0).describe("Pagination offset (default 0)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, until, since, path, merges, limit, start }) => {
      try {
        const bb = await getClient();
        const result = await bb.listCommits(projectKey, repoSlug, {
          until,
          since,
          path,
          merges,
          limit,
          start,
        });
        if (result.values.length === 0) {
          return { content: [{ type: "text", text: `No commits found.` }] };
        }
        const lines = result.values.map((c) => {
          const date = new Date(c.authorTimestamp).toISOString().split("T")[0];
          const subject = c.message.split("\n")[0];
          return `- **${c.displayId}** ${date} ${pi.scrub(c.author.name) ?? "Unknown"}: ${pi.scrubText(subject)}`;
        });
        const shownEnd = start + result.values.length;
        const ctx = path ? ` for ${path}` : "";
        const range = until ? (since ? ` (${since}..${until})` : ` (until ${until})`) : "";
        // Bitbucket DC commits endpoint doesn't return a total count;
        // result.size is the per-page size. Report returned-N + range
        // rather than implying a total.
        const header = `### Commits${ctx}${range} — returned ${result.values.length} (showing ${start + 1}–${shownEnd})`;
        const footer = !result.isLastPage
          ? `\n\n_More available — call again with start=${result.nextPageStart ?? shownEnd}._`
          : "";
        return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}${footer}` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing commits: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_commit",
    "Get details for a single commit by SHA — full message, author, parents.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      commitId: z.string().describe("Full or partial commit SHA"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, commitId }) => {
      try {
        const bb = await getClient();
        const c = await bb.getCommit(projectKey, repoSlug, commitId);
        const date = new Date(c.authorTimestamp).toISOString().split("T")[0];
        const parents = c.parents.map((p) => p.displayId).join(", ") || "(root)";
        return {
          content: [
            {
              type: "text",
              text:
                `### Commit ${c.displayId}\n` +
                `**Author:** ${pi.scrub(c.author.name) ?? "Unknown"} <${pi.scrub(c.author.emailAddress) ?? ""}>\n` +
                `**Date:** ${date}\n` +
                `**Parents:** ${parents}\n\n` +
                `${pi.scrubText(c.message)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching commit: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "blame_file",
    `Show line-by-line authorship for a file ("git blame"). Each line is annotated with the commit SHA, author, and date that last touched it.

Output is annotated source. Returns up to maxLines lines (default 5000) — for huge files, narrow with start/end (1-based, inclusive). Tip: pair with get_commit to see the full message of a flagged commit.`,
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      filePath: z.string().describe("File path within the repo"),
      at: z
        .string()
        .optional()
        .describe("Branch, tag, or commit to blame at (default branch if omitted)"),
      maxLines: z
        .number()
        .min(1)
        .max(20000)
        .default(5000)
        .describe("Max lines to fetch (default 5000)"),
      startLine: z
        .number()
        .min(1)
        .optional()
        .describe("First line to display (1-based, inclusive). Defaults to 1."),
      endLine: z
        .number()
        .min(1)
        .optional()
        .describe("Last line to display (1-based, inclusive). Defaults to all returned lines."),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, filePath, at, maxLines, startLine, endLine }) => {
      try {
        // Validate range up front so we fail fast with a clear message
        // instead of returning an empty block with an invalid header.
        if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid range: startLine=${startLine} > endLine=${endLine}.`,
              },
            ],
            isError: true,
          };
        }

        const bb = await getClient();
        // Plumb startLine into the Bitbucket browse pagination so blaming
        // a slice deep in a huge file fetches only that slice.
        const result = await bb.blameFile(projectKey, repoSlug, filePath, {
          at,
          maxLines,
          startLine,
        });
        if (result.lines.length === 0) {
          if (startLine !== undefined && startLine > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `No content for ${filePath} starting at line ${startLine}. The file may be shorter than ${startLine} lines.`,
                },
              ],
            };
          }
          return { content: [{ type: "text", text: `No content for ${filePath}.` }] };
        }

        // `result.start` is the 0-based offset of the first fetched line in
        // the source file. Subsequent line numbers count from there.
        const firstLineNumber = result.start + 1; // 1-based for display
        const lastLineNumber = result.start + result.lines.length;

        // Build a per-line lookup from the blame ranges, indexed against
        // the fetched window (not the absolute file).
        const annotation: Array<{ commit: string; author: string; date: string }> = new Array(result.lines.length);
        for (const range of result.blame) {
          const author = pi.scrub(range.authorName) ?? "Unknown";
          const date = range.authorTimestamp
            ? new Date(range.authorTimestamp).toISOString().split("T")[0]
            : "?";
          const commit = range.commitDisplayId ?? range.commitId?.slice(0, 8) ?? "?";
          for (let i = 0; i < range.spannedLines; i++) {
            // Blame range.lineNumber is 1-based against the absolute file —
            // translate to the fetched window.
            const absLine = range.lineNumber + i;
            const idx = absLine - firstLineNumber;
            if (idx >= 0 && idx < result.lines.length) {
              annotation[idx] = { commit, author, date };
            }
          }
        }

        // Determine the display slice. endLine clamps the upper bound; the
        // lower bound is just where we started fetching from.
        const displayEndAbs = Math.min(
          lastLineNumber,
          endLine ?? lastLineNumber
        );
        const hiIdx = displayEndAbs - firstLineNumber + 1; // exclusive

        const out: string[] = [];
        out.push(
          `### Blame for ${filePath} ${at ? `@ ${at}` : "(default branch)"} — lines ${firstLineNumber}–${displayEndAbs}${result.isLastPage ? "" : "+"}`
        );
        out.push("```");
        for (let i = 0; i < hiIdx; i++) {
          const a = annotation[i] ?? { commit: "?".repeat(8), author: "?", date: "?" };
          const lineNum = String(firstLineNumber + i).padStart(5, " ");
          const meta = `${a.commit.padEnd(8, " ")} ${a.date} ${a.author.padEnd(20, " ").slice(0, 20)}`;
          out.push(`${lineNum} | ${meta} | ${result.lines[i]?.text ?? ""}`);
        }
        out.push("```");
        if (!result.isLastPage) {
          out.push(`\n_File has more lines beyond ${lastLineNumber}. Re-call with startLine=${lastLineNumber + 1} to continue._`);
        }
        return { content: [{ type: "text", text: out.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error blaming file: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  server.tool(
    "list_tags",
    "List tags in a Bitbucket repository. Useful for finding releases. Order by ALPHABETICAL or MODIFICATION (most recently modified first).",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      filterText: z
        .string()
        .optional()
        .describe("Substring filter (e.g., 'release/' or 'v3.')"),
      orderBy: z
        .enum(["ALPHABETICAL", "MODIFICATION"])
        .optional()
        .describe("Sort order (default: alphabetical from server)"),
      limit: z.number().min(1).max(100).default(25).describe("Page size (default 25)"),
      start: z.number().min(0).default(0).describe("Pagination offset"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, filterText, orderBy, limit, start }) => {
      try {
        const bb = await getClient();
        const result = await bb.listTags(projectKey, repoSlug, { filterText, orderBy, limit, start });
        if (result.values.length === 0) {
          return { content: [{ type: "text", text: `No tags found${filterText ? ` matching '${filterText}'` : ""}.` }] };
        }
        const lines = result.values.map((t) => `- **${t.displayId}** → ${t.latestCommit.slice(0, 8)}`);
        const shownEnd = start + result.values.length;
        // Bitbucket DC tags endpoint doesn't return a total. Report
        // returned-N rather than implying a total.
        const header = `### Tags${filterText ? ` matching '${filterText}'` : ""} — returned ${result.values.length} (showing ${start + 1}–${shownEnd})`;
        const footer = !result.isLastPage
          ? `\n\n_More available — call again with start=${result.nextPageStart ?? shownEnd}._`
          : "";
        return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}${footer}` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing tags: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_tag",
    "Get a single tag by name with its commit info.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      tagName: z.string().describe("Tag name (without refs/tags/)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, repoSlug, tagName }) => {
      try {
        const bb = await getClient();
        const tag = await bb.getTag(projectKey, repoSlug, tagName);
        return {
          content: [
            {
              type: "text",
              text: `**Tag:** ${tag.displayId}\n**Commit:** ${tag.latestCommit}${tag.hash ? `\n**Annotated SHA:** ${tag.hash}` : "\n_(lightweight tag)_"}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching tag: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_tag",
    "Create a tag pointing at a branch, commit, or another tag. If `message` is given the tag is annotated; otherwise lightweight. Always confirm with the user before tagging — tags are typically used for releases and visible to other tools/CI.",
    {
      projectKey: z.string().describe("Bitbucket project key"),
      repoSlug: z.string().describe("Repository slug"),
      name: z.string().describe("Tag name (e.g., 'v3.2.1' or 'release/2026-05-09')"),
      startPoint: z
        .string()
        .describe("Branch, commit, or existing tag to anchor the new tag to"),
      message: z
        .string()
        .optional()
        .describe("Annotation message — pass to make the tag annotated, omit for lightweight"),
    },
    { readOnlyHint: false },
    async ({ projectKey, repoSlug, name, startPoint, message }) => {
      try {
        const bb = await getClient();
        const tag = await bb.createTag(projectKey, repoSlug, name, startPoint, message);
        return {
          content: [
            {
              type: "text",
              text: `Created ${message !== undefined ? "annotated" : "lightweight"} tag **${tag.displayId}** at ${tag.latestCommit.slice(0, 8)}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error creating tag: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Build status
  // ---------------------------------------------------------------------------

  server.tool(
    "get_build_status",
    "Get CI build statuses attached to a commit (Jenkins, etc. post statuses to /rest/build-status/1.0/). Useful before merging to confirm CI is green. Paged — use start to walk beyond the first page when a commit has many statuses.",
    {
      commitId: z.string().describe("Full commit SHA"),
      limit: z.number().min(1).max(100).default(25).describe("Page size (default 25)"),
      start: z.number().min(0).default(0).describe("Pagination offset (default 0)"),
    },
    { readOnlyHint: true },
    async ({ commitId, limit, start }) => {
      try {
        const bb = await getClient();
        const result = await bb.getBuildStatus(commitId, limit, start);
        if (result.values.length === 0) {
          return { content: [{ type: "text", text: `No build statuses on commit ${commitId.slice(0, 8)}.` }] };
        }
        const lines = result.values.map((b) => {
          const date = b.dateAdded ? new Date(b.dateAdded).toISOString().split("T")[0] : "?";
          // name/key/description come from external CI integrations (Jenkins,
          // GitHub Actions, etc.) and can contain arbitrary text. Run through
          // the PI scrubber like commit messages / PR comments do.
          const name = pi.scrubText(b.name ?? b.key);
          const url = b.url ? `\n  ${b.url}` : "";
          const desc = b.description ? `\n  _${pi.scrubText(b.description)}_` : "";
          return `- **[${b.state}]** ${name} — ${date}${url}${desc}`;
        });
        const shownEnd = start + result.values.length;
        // The /rest/build-status/1.0/ endpoint doesn't return a cross-page
        // total. Report returned-N for this page rather than implying a total.
        const header = `### Build statuses on ${commitId.slice(0, 8)} — returned ${result.values.length} (showing ${start + 1}–${shownEnd})`;
        const footer = !result.isLastPage
          ? `\n\n_More available — call again with start=${result.nextPageStart ?? shownEnd}._`
          : "";
        return {
          content: [
            { type: "text", text: `${header}\n\n${lines.join("\n")}${footer}` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching build status: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
