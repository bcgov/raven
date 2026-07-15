import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { AdoClient } from "./ado-client.js";
import type { AdoWorkItem, AdoPatchOperation } from "./types.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function field(item: AdoWorkItem, name: string): string {
  return String(item.fields[name] ?? "");
}

function formatWorkItem(item: AdoWorkItem): string {
  const id       = item.id;
  const title    = field(item, "System.Title");
  const type     = field(item, "System.WorkItemType");
  const state    = field(item, "System.State");
  const priority = field(item, "Microsoft.VSTS.Common.Priority");
  const assigned = (item.fields["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName ?? "Unassigned";
  const created  = field(item, "System.CreatedDate");
  const updated  = field(item, "System.ChangedDate");
  const desc     = sanitizeHtml(field(item, "System.Description"), { allowedTags: [], allowedAttributes: {} }).replace(/\s{2,}/g, " ").trim();
  const repro    = sanitizeHtml(field(item, "Microsoft.VSTS.TCM.ReproSteps"), { allowedTags: [], allowedAttributes: {} }).replace(/\s{2,}/g, " ").trim();

  const lines = [
    `### [#${id}] ${title}`,
    `**Type:** ${type} | **State:** ${state} | **Priority:** ${priority || "—"}`,
    `**Assigned to:** ${assigned}`,
    `**Created:** ${created} | **Updated:** ${updated}`,
  ];
  if (desc) lines.push(`\n**Description:**\n${desc.slice(0, 1500)}`);
  if (repro) lines.push(`\n**Repro Steps:**\n${repro.slice(0, 1500)}`);
  return lines.join("\n");
}

function refNameToBranch(refName: string): string {
  return refName.replace(/^refs\/heads\//, "");
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------


const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createAdoServer(): McpServer {
  const server = new McpServer(
    { name: "RAVEN Azure DevOps", version: "0.1.0" },
    {
      instructions: `You have access to tools for a locally hosted Azure DevOps Server instance. Tools cover work items (search, read, create, update, comment), repositories, branches, file browsing, pull requests, and pipelines. Write tools (create_work_item, update_work_item, add_work_item_comment, create_pull_request) modify live ADO data — confirm with the user before calling them. Set ADO_BASE_URL, ADO_PAT, and ADO_DEFAULT_PROJECT in ~/.raven/.env (or the DPAPI-encrypted equivalent on Windows). For multi-collection ADO Server instances, set ADO_DEFAULT_COLLECTION or pass the collection parameter to each tool.${WORKAROUND_NOTE}`,
    }
  );

  let client: AdoClient | null = null;

  function getClient(): AdoClient {
    if (!client) {
      const baseUrl = process.env["ADO_BASE_URL"];
      const pat     = process.env["ADO_PAT"];
      if (!baseUrl) throw new Error("ADO_BASE_URL is not set. Add it to ~/.raven/.env.");
      if (!pat)     throw new Error("ADO_PAT is not set. Add it to ~/.raven/.env.");
      const apiVersion = process.env["ADO_API_VERSION"] ?? "7.1";
      client = new AdoClient(baseUrl, pat, apiVersion);
    }
    return client;
  }

  function defaultProject(supplied?: string): string {
    const p = supplied || process.env["ADO_DEFAULT_PROJECT"];
    if (!p) throw new Error("No project supplied and ADO_DEFAULT_PROJECT is not set.");
    return p;
  }

  function defaultCollection(supplied?: string): string | undefined {
    return supplied || process.env["ADO_DEFAULT_COLLECTION"] || undefined;
  }

  const safeErr = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

  // ---------------------------------------------------------------------------
  // Work item tools
  // ---------------------------------------------------------------------------

  server.tool(
    "search_work_items",
    `Search Azure DevOps work items using WIQL (Work Item Query Language).

Examples:
  wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC"
  wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.State] = 'Active'"
  wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS 'login'"

Use @project as a placeholder for the project name — it is substituted automatically.
Returns the top matching work items with their titles, types, states, and priorities.`,
    {
      wiql: z.string().describe("WIQL query string"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
      top: z.number().int().min(1).max(200).default(20).describe("Maximum number of results"),
    },
    { readOnlyHint: true },
    async ({ wiql, project, collection, top }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const col  = defaultCollection(collection);
        const result = await ado.queryWiql(wiql, proj, top, col);
        const ids = result.workItems.map((r) => r.id);
        if (ids.length === 0) return { content: [{ type: "text", text: "No work items matched the query." }] };

        const items = await ado.getWorkItems(ids.slice(0, top), proj, col);
        const text = items.map(formatWorkItem).join("\n\n---\n\n");
        return { content: [{ type: "text", text: `**${items.length} work item(s) found:**\n\n${text}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_work_item",
    "Get full details of an Azure DevOps work item by its numeric ID.",
    {
      id: z.number().int().describe("Work item ID"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ id, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const col  = defaultCollection(collection);
        const item = await ado.getWorkItem(id, proj, col);

        // Append comments
        let commentsText = "";
        try {
          const comments = await ado.getWorkItemComments(id, proj, col);
          if (comments.comments.length > 0) {
            commentsText = "\n\n**Comments:**\n" + comments.comments
              .slice(0, 20)
              .map((c) => `- **${c.createdBy.displayName}** (${c.createdDate.slice(0, 10)}): ${sanitizeHtml(c.text, { allowedTags: [], allowedAttributes: {} }).trim()}`)
              .join("\n");
          }
        } catch { /* comments are optional */ }

        return { content: [{ type: "text", text: formatWorkItem(item) + commentsText }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_work_item",
    `Create a new work item in Azure DevOps.

Work item types depend on the process template: Bug, Task, User Story, Feature, Epic, Issue.
Priority values: 1 (Critical), 2 (High), 3 (Medium), 4 (Low).`,
    {
      type: z.string().describe("Work item type, e.g. 'Bug', 'Task', 'User Story'"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Description (HTML allowed)"),
      priority: z.number().int().min(1).max(4).optional().describe("Priority: 1=Critical, 2=High, 3=Medium, 4=Low"),
      assignedTo: z.string().optional().describe("Assigned to (email or display name)"),
      areaPath: z.string().optional().describe("Area path, e.g. 'MyProject\\\\Frontend'"),
      iterationPath: z.string().optional().describe("Iteration path, e.g. 'MyProject\\\\Sprint 5'"),
      tags: z.string().optional().describe("Semicolon-separated tags"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: false },
    async ({ type, title, description, priority, assignedTo, areaPath, iterationPath, tags, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const col  = defaultCollection(collection);

        const ops: AdoPatchOperation[] = [
          { op: "add", path: "/fields/System.Title", value: title },
        ];
        if (description)    ops.push({ op: "add", path: "/fields/System.Description", value: description });
        if (priority)       ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: priority });
        if (assignedTo)     ops.push({ op: "add", path: "/fields/System.AssignedTo", value: assignedTo });
        if (areaPath)       ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
        if (iterationPath)  ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
        if (tags)           ops.push({ op: "add", path: "/fields/System.Tags", value: tags });

        const item = await ado.createWorkItem(type, proj, ops, col);
        return { content: [{ type: "text", text: `Work item created: #${item.id} — ${field(item, "System.Title")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_work_item",
    "Update fields on an existing Azure DevOps work item.",
    {
      id: z.number().int().describe("Work item ID to update"),
      title: z.string().optional().describe("New title"),
      state: z.string().optional().describe("New state, e.g. 'Active', 'Resolved', 'Closed'"),
      priority: z.number().int().min(1).max(4).optional().describe("New priority"),
      assignedTo: z.string().optional().describe("Assign to (email or display name)"),
      description: z.string().optional().describe("New description (HTML allowed)"),
      tags: z.string().optional().describe("Semicolon-separated tags (replaces existing)"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: false },
    async ({ id, title, state, priority, assignedTo, description, tags, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const col  = defaultCollection(collection);

        const ops: AdoPatchOperation[] = [];
        if (title)       ops.push({ op: "replace", path: "/fields/System.Title", value: title });
        if (state)       ops.push({ op: "replace", path: "/fields/System.State", value: state });
        if (priority)    ops.push({ op: "replace", path: "/fields/Microsoft.VSTS.Common.Priority", value: priority });
        if (assignedTo)  ops.push({ op: "replace", path: "/fields/System.AssignedTo", value: assignedTo });
        if (description) ops.push({ op: "replace", path: "/fields/System.Description", value: description });
        if (tags)        ops.push({ op: "replace", path: "/fields/System.Tags", value: tags });

        if (ops.length === 0) {
          return { content: [{ type: "text", text: "No fields to update were provided." }] };
        }

        const item = await ado.updateWorkItem(id, proj, ops, col);
        return { content: [{ type: "text", text: `Work item #${item.id} updated successfully.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "add_work_item_comment",
    "Add a comment to an Azure DevOps work item. HTML is supported.",
    {
      id: z.number().int().describe("Work item ID"),
      text: z.string().describe("Comment text (HTML allowed)"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: false },
    async ({ id, text, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const col  = defaultCollection(collection);
        await ado.addWorkItemComment(id, proj, text, col);
        return { content: [{ type: "text", text: `Comment added to work item #${id}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Repository tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_repos",
    "List all Git repositories in an Azure DevOps project.",
    {
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const data = await ado.listRepositories(proj, defaultCollection(collection));
        const lines = data.value.map(
          (r) => `- **${r.name}** (id: ${r.id}) — default branch: ${r.defaultBranch ?? "unknown"}\n  ${r.webUrl ?? ""}`
        );
        return { content: [{ type: "text", text: `**${data.count} repo(s) in ${proj}:**\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_branches",
    "List branches in an Azure DevOps Git repository.",
    {
      repo: z.string().describe("Repository name or ID"),
      filter: z.string().optional().describe("Optional substring filter for branch names"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ repo, filter, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const data = await ado.listBranches(proj, repo, filter, defaultCollection(collection));
        const branches = data.value.filter((r) => r.name.startsWith("refs/heads/"));
        const lines = branches.map(
          (r) => `- ${refNameToBranch(r.name)} (${r.objectId.slice(0, 8)})`
        );
        return { content: [{ type: "text", text: `**${branches.length} branch(es) in ${repo}:**\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "browse_files",
    "Browse the directory tree of an Azure DevOps Git repository at a given path.",
    {
      repo: z.string().describe("Repository name or ID"),
      path: z.string().default("/").describe("Path to browse (default: root '/')"),
      branch: z.string().default("main").describe("Branch name (default: 'main')"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ repo, path, branch, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const data = await ado.browseFiles(proj, repo, path, branch, defaultCollection(collection));
        const lines = data.value.map(
          (item) => `${item.isFolder ? "📁" : "📄"} ${item.path}`
        );
        return { content: [{ type: "text", text: `**${data.count} item(s) at ${path} (${branch}):**\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_file",
    "Read the contents of a file in an Azure DevOps Git repository.",
    {
      repo: z.string().describe("Repository name or ID"),
      path: z.string().describe("File path, e.g. '/src/main/java/com/example/App.java'"),
      branch: z.string().default("main").describe("Branch name (default: 'main')"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ repo, path, branch, project, collection }) => {
      try {
        const ado     = getClient();
        const proj    = defaultProject(project);
        const content = await ado.readFile(proj, repo, path, branch, defaultCollection(collection));
        const truncated = content.length > 50_000
          ? content.slice(0, 50_000) + "\n\n[...truncated at 50 000 characters]"
          : content;
        return { content: [{ type: "text", text: `**${path}** (${branch})\n\n\`\`\`\n${truncated}\n\`\`\`` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Pull request tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_pull_requests",
    "List pull requests in an Azure DevOps Git repository.",
    {
      repo: z.string().describe("Repository name or ID"),
      status: z.enum(["active", "completed", "abandoned", "all"]).default("active").describe("PR status filter"),
      top: z.number().int().min(1).max(100).default(25).describe("Maximum number of results"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ repo, status, top, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const data = await ado.listPullRequests(proj, repo, status, top, defaultCollection(collection));
        if (data.count === 0) return { content: [{ type: "text", text: `No ${status} pull requests found in ${repo}.` }] };

        const lines = data.value.map((pr) =>
          `- **#${pr.pullRequestId}** ${pr.title}\n  ${refNameToBranch(pr.sourceRefName)} → ${refNameToBranch(pr.targetRefName)} | by ${pr.createdBy.displayName} | ${pr.status}`
        );
        return { content: [{ type: "text", text: `**${data.count} PR(s) in ${repo} (${status}):**\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_pull_request",
    "Get full details of an Azure DevOps pull request by ID.",
    {
      repo: z.string().describe("Repository name or ID"),
      prId: z.number().int().describe("Pull request ID"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ repo, prId, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const pr   = await ado.getPullRequest(proj, repo, prId, defaultCollection(collection));

        const reviewers = pr.reviewers
          .map((r) => {
            const vote = r.vote === 10 ? "✅" : r.vote === -10 ? "❌" : r.vote === 5 ? "✔" : "⏳";
            return `  ${vote} ${r.displayName}`;
          })
          .join("\n");

        const text = [
          `### PR #${pr.pullRequestId}: ${pr.title}`,
          `**Status:** ${pr.status} | **Created:** ${pr.creationDate.slice(0, 10)}`,
          `**From:** ${refNameToBranch(pr.sourceRefName)} → **Into:** ${refNameToBranch(pr.targetRefName)}`,
          `**Author:** ${pr.createdBy.displayName}`,
          reviewers ? `**Reviewers:**\n${reviewers}` : "",
          pr.description ? `\n**Description:**\n${pr.description}` : "",
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_pull_request",
    "Create a pull request in an Azure DevOps Git repository.",
    {
      repo: z.string().describe("Repository name or ID"),
      title: z.string().describe("PR title"),
      sourceBranch: z.string().describe("Source branch name, e.g. 'feature/my-branch'"),
      targetBranch: z.string().describe("Target branch name, e.g. 'main' or 'release/2.0'"),
      description: z.string().optional().describe("PR description"),
      isDraft: z.boolean().default(false).describe("Create as draft PR"),
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: false },
    async ({ repo, title, sourceBranch, targetBranch, description, isDraft, project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const pr   = await ado.createPullRequest(proj, repo, {
          title,
          description,
          sourceRefName: `refs/heads/${sourceBranch}`,
          targetRefName: `refs/heads/${targetBranch}`,
          isDraft,
        }, defaultCollection(collection));
        return {
          content: [{
            type: "text",
            text: `Pull request created: **#${pr.pullRequestId}** — ${pr.title}\n${pr.url ?? ""}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Pipeline tool
  // ---------------------------------------------------------------------------

  server.tool(
    "list_projects",
    "List all team projects across all collections in the Azure DevOps Server instance.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const ado = getClient();
        const collections = await ado.listCollections();
        if (collections.count === 0) return { content: [{ type: "text", text: "No collections found." }] };

        const sections: string[] = [];
        for (const col of collections.value) {
          try {
            const data = await ado.listProjects(col.name);
            if (data.count === 0) {
              sections.push(`### ${col.name}\n_No projects._`);
            } else {
              const lines = data.value.map(
                (p) => `- **${p.name}** (${p.state})${p.description ? " — " + p.description : ""}`
              );
              sections.push(`### ${col.name}\n${lines.join("\n")}`);
            }
          } catch (colErr) {
            sections.push(`### ${col.name}\n_Error: ${safeErr(colErr)}_`);
          }
        }
        return { content: [{ type: "text", text: sections.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_pipelines",
    "List build pipelines defined in an Azure DevOps project.",
    {
      project: z.string().optional().describe("Project name (uses ADO_DEFAULT_PROJECT if omitted)"),
      collection: z.string().optional().describe("Collection name (e.g. 'ECON' or 'LBR_Projects_Collection') — required on multi-collection ADO Server instances"),
    },
    { readOnlyHint: true },
    async ({ project, collection }) => {
      try {
        const ado  = getClient();
        const proj = defaultProject(project);
        const data = await ado.listPipelines(proj, defaultCollection(collection));
        if (data.count === 0) return { content: [{ type: "text", text: `No pipelines found in ${proj}.` }] };
        const lines = data.value.map(
          (p) => `- **#${p.id}** ${p.folder ? p.folder + "\\" : ""}${p.name}`
        );
        return { content: [{ type: "text", text: `**${data.count} pipeline(s) in ${proj}:**\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  return server;
}
