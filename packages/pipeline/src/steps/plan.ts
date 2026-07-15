import type { BitbucketClient } from "@nrs/bitbucket-mcp/client";
import { isValidProject } from "../bitbucket-projects.js";
import { askAI } from "../ai-client.js";
import { startSpinner, stopSpinner } from "../spinner.js";
import type { FixPlan, PipelineContext } from "../types.js";
import { getMapping, setMapping } from "../repo-map.js";

const PLAN_SYSTEM_PROMPT = `You are a senior Java developer analyzing a production bug.
Given the error, stack trace, and relevant source files, respond in TWO sections:

SECTION 1 — JSON analysis (on a single line, no newlines inside the JSON):
{"affectedFiles":["full/path/from/repo/root/File.java"],"rootCause":"explanation","proposedFix":"description","patch":""}

SECTION 2 — Unified diff patch (after a blank line):
A standard unified diff that can be applied with \`git apply\`.
IMPORTANT: The file paths in the diff MUST match the paths shown in the source file headers (everything after "repo-name/").
Use the standard git diff format:
  --- a/full/path/from/repo/root/File.java
  +++ b/full/path/from/repo/root/File.java

Respond with ONLY these two sections — no markdown fences or extra text.`;

/**
 * Step 3: PLAN — Analyze source code and generate a fix plan using AI.
 * Searches the app repo first, then dependencies/sibling repos if needed.
 */
export async function plan(
  ctx: PipelineContext,
  bitbucketClient: BitbucketClient
): Promise<void> {
  if (ctx.isDuplicate) {
    console.log("[PLAN] Duplicate ticket — skipping");
    return;
  }
  if (!ctx.ticketKey && !ctx.dryRun) {
    console.log("[PLAN] No ticket created — skipping");
    return;
  }

  let project = ctx.bitbucketProject ?? ctx.app;
  let repo = ctx.bitbucketRepo ?? ctx.component;
  // Keep the original component repo — always search it even if cache points elsewhere
  const originalRepo = ctx.bitbucketRepo ?? ctx.component;
  const originalProject = ctx.bitbucketProject ?? ctx.app;

  // Check repo map cache for a known mapping
  const cached = getMapping(ctx.app, ctx.component);
  if (cached) {
    if (!ctx.bitbucketProject) project = cached.bitbucketProject;
    if (!ctx.bitbucketRepo) repo = cached.bitbucketRepo;
    console.log(`[PLAN] Using cached repo mapping: ${project}/${repo}`);
  }

  console.log(`[PLAN] Analyzing ${project}/${repo} for fix...`);

  const topError = ctx.errors[0]!;

  // Extract class names from ALL errors, not just the top one
  const targetClasses = new Set<string>();
  const fileHints: string[] = [];
  for (const err of ctx.errors) {
    for (const cls of extractTargetClasses(err.message, err.stackTrace)) {
      targetClasses.add(cls);
    }
    for (const hint of extractFileHints(err.stackTrace, err.message)) {
      if (!fileHints.includes(hint)) fileHints.push(hint);
    }
  }
  console.log(`[PLAN] Target classes: ${[...targetClasses].join(", ") || "(none)"}`);
  console.log(`[PLAN] Stack trace file hints: ${fileHints.length}`);

  // --- Source finding strategy ---
  // 1. Try direct file paths from stack trace in the app repo
  // 2. Walk the app repo tree for matching class names
  // 3. Read pom.xml for internal dependencies → search those repos
  // 4. List sibling repos in the same Bitbucket project → search those
  // Each sourceFile records BOTH the repo and the project it was found in.
  // Sibling-search and dependency-search strategies can locate files in
  // OTHER projects (via the repo map cache or sibling project iteration);
  // tracking just the repo would let IMPLEMENT/CREATE-PR clone and push
  // under the wrong project key.
  const sourceFiles: Array<{ path: string; content: string; repo: string; project: string }> = [];
  let sourceFoundInRepo = repo;
  let sourceFoundInProject = project;

  // Strategy 1: Direct file paths from stack trace
  for (const hint of fileHints.slice(0, 5)) {
    try {
      const content = await bitbucketClient.readFile(project, repo, hint);
      sourceFiles.push({ path: hint, content, repo, project });
      console.log(`[PLAN] Read: ${project}/${repo}/${hint}`);
    } catch {
      // Not found at that exact path
    }
  }

  // Strategy 2: Walk the app repo tree
  if (targetClasses.size > 0) {
    const remainingClasses = new Set([...targetClasses].filter(
      (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
    ));
    if (remainingClasses.size > 0) {
      console.log(`[PLAN] Searching ${project}/${repo} tree for: ${[...remainingClasses].join(", ")}`);
      startSpinner("Searching repo tree...");
      const found = await findFilesInRepo(bitbucketClient, project, repo, remainingClasses);
      stopSpinner();
      for (const filePath of found.slice(0, 3)) {
        try {
          const content = await bitbucketClient.readFile(project, repo, filePath);
          sourceFiles.push({ path: filePath, content, repo, project });
          console.log(`[PLAN] Found in app repo: ${filePath}`);
        } catch { /* skip */ }
      }
    }
  }

  // Strategy 2b: If cache pointed to a different repo, also search the original component repo
  if (repo !== originalRepo || project !== originalProject) {
    const still = new Set([...targetClasses].filter(
      (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
    ));
    if (still.size > 0) {
      console.log(`[PLAN] Also searching original repo: ${originalProject}/${originalRepo}`);
      const found = await findFilesInRepo(bitbucketClient, originalProject, originalRepo, still);
      for (const filePath of found.slice(0, 3)) {
        try {
          const content = await bitbucketClient.readFile(originalProject, originalRepo, filePath);
          sourceFiles.push({ path: filePath, content, repo: originalRepo, project: originalProject });
          console.log(`[PLAN] Found in original repo: ${originalProject}/${originalRepo}/${filePath}`);
        } catch { /* skip */ }
      }
    }
  }

  // Strategy 3: Read pom.xml for internal dependencies — search for classes NOT yet found
  const unfoundClasses = new Set([...targetClasses].filter(
    (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
  ));
  if (unfoundClasses.size > 0) {
    console.log(`[PLAN] Source not in app repo — checking dependencies...`);
    startSpinner("Reading pom.xml for dependencies...");
    const depRepos = await findDependencyRepos(bitbucketClient, project, repo);
    stopSpinner();
    console.log(`[PLAN] Found ${depRepos.length} dependency repo(s) to search`);

    // Search dependencies in parallel batches of 5
    startSpinner("Searching dependency repos...");
    for (let i = 0; i < depRepos.length && unfoundClasses.size > 0; i += 5) {
      const batch = depRepos.slice(i, i + 5);
      const results = await Promise.all(
        batch.map((dr) => findFilesInRepo(bitbucketClient, project, dr, unfoundClasses).then(
          (found) => ({ repo: dr, found }),
          () => ({ repo: dr, found: [] as string[] })
        ))
      );
      for (const { repo: depRepo, found } of results) {
        if (unfoundClasses.size === 0) break;
        for (const filePath of found.slice(0, 3)) {
          try {
            const content = await bitbucketClient.readFile(project, depRepo, filePath);
            sourceFiles.push({ path: filePath, content, repo: depRepo, project });
            const fileName = filePath.split("/").pop();
            if (fileName) unfoundClasses.delete(fileName);
            console.log(`[PLAN] Found in dependency repo: ${project}/${depRepo}/${filePath}`);
          } catch { /* skip */ }
        }
      }
    }
    stopSpinner();
  }

  // Strategy 4: Search sibling repos for any still-unfound classes
  const stillUnfound = new Set([...targetClasses].filter(
    (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
  ));
  if (stillUnfound.size > 0) {
    // First, try repos we already know about from the repo map cache
    const repoMap = await import("../repo-map.js");
    const knownMap = repoMap.loadRepoMap();
    const triedRepos = new Set<string>([`${project}/${repo}`]);

    // Collect known repos from the map as priority candidates
    const knownRepos: Array<{ project: string; repo: string }> = [];
    for (const mapping of Object.values(knownMap)) {
      if (!isValidProject(mapping.bitbucketProject)) continue;
      const key = `${mapping.bitbucketProject}/${mapping.bitbucketRepo}`;
      if (!triedRepos.has(key)) {
        knownRepos.push({ project: mapping.bitbucketProject, repo: mapping.bitbucketRepo });
        triedRepos.add(key);
      }
    }

    // Search known repos first (fast — usually just 1-2 repos)
    if (knownRepos.length > 0) {
      console.log(`[PLAN] Trying ${knownRepos.length} known repo(s) from cache...`);
      const results = await Promise.all(
        knownRepos.map((kr) => findFilesInRepo(bitbucketClient, kr.project, kr.repo, stillUnfound).then(
          (found) => ({ ...kr, found }),
          () => ({ ...kr, found: [] as string[] })
        ))
      );
      for (const { project: p, repo: r, found } of results) {
        if (stillUnfound.size === 0) break;
        for (const filePath of found.slice(0, 3)) {
          try {
            const content = await bitbucketClient.readFile(p, r, filePath);
            sourceFiles.push({ path: filePath, content, repo: r, project: p });
            const fileName = filePath.split("/").pop();
            if (fileName) stillUnfound.delete(fileName);
            console.log(`[PLAN] Found in cached repo: ${p}/${r}/${filePath}`);
          } catch { /* skip */ }
        }
      }
    }

    // If still unfound, do a targeted sibling search (library repos only, max 10)
    if (stillUnfound.size > 0) {
      const projectsToSearch = [project];
      // Add the original project if it differs from the cached one
      if (originalProject !== project && !projectsToSearch.includes(originalProject)) {
        projectsToSearch.push(originalProject);
      }
      // Add known projects from the repo map, but only valid Bitbucket keys
      for (const mapping of Object.values(knownMap)) {
        if (isValidProject(mapping.bitbucketProject) && !projectsToSearch.includes(mapping.bitbucketProject)) {
          projectsToSearch.push(mapping.bitbucketProject);
        }
      }

      for (const searchProject of projectsToSearch) {
        if (stillUnfound.size === 0) break;
        console.log(`[PLAN] Searching sibling repos in project ${searchProject} for: ${[...stillUnfound].join(", ")}`);
        try {
          const repos = await bitbucketClient.listRepos(searchProject, 100);
          const siblingRepos = repos.values
            .map((r) => r.slug)
            .filter((slug) => {
              if (triedRepos.has(`${searchProject}/${slug}`)) return false;
              // Skip non-code repos (deploy, config, docs, test, devops, pipeline, infra)
              if (/-(deploy|config|docs?|test|devops|pipeline|infra|helm|chart|terraform)$/.test(slug)) return false;
              return true;
            })
            .sort((a, b) => {
              // Prioritize: library repos first, then repos matching class package hints
              const aScore = (isLibraryRepo(a) ? -10 : 0) + (a.includes("generic") || a.includes("common") ? -5 : 0);
              const bScore = (isLibraryRepo(b) ? -10 : 0) + (b.includes("generic") || b.includes("common") ? -5 : 0);
              return aScore - bScore;
            })
            .slice(0, 10); // Cap at 10 repos

          console.log(`[PLAN] ${siblingRepos.length} sibling repo(s) to search (filtered)`);

          // Search all 10 in parallel (single batch)
          startSpinner("Searching sibling repos...");
          const results = await Promise.all(
            siblingRepos.map((sr) => {
              triedRepos.add(`${searchProject}/${sr}`);
              return findFilesInRepo(bitbucketClient, searchProject, sr, stillUnfound).then(
                (found) => ({ repo: sr, found }),
                () => ({ repo: sr, found: [] as string[] })
              );
            })
          );
          stopSpinner();
          for (const { repo: siblingRepo, found } of results) {
            if (stillUnfound.size === 0) break;
            for (const filePath of found.slice(0, 3)) {
              try {
                const content = await bitbucketClient.readFile(searchProject, siblingRepo, filePath);
                sourceFiles.push({ path: filePath, content, repo: siblingRepo, project: searchProject });
                const fileName = filePath.split("/").pop();
                if (fileName) stillUnfound.delete(fileName);
                console.log(`[PLAN] Found in sibling repo: ${searchProject}/${siblingRepo}/${filePath}`);
              } catch { /* skip */ }
            }
          }
        } catch (e) {
          console.log(`[PLAN] Could not list repos in ${searchProject}: ${(e as Error).message}`);
        }
      }
    }
  }

  // Build source context for AI (with truncation for token limits)
  // Format: "--- repo: <repo-name> path: <path-from-repo-root> ---"
  const sourceContext = sourceFiles.map((sf) => {
    const trimmed = extractRelevantCode(sf.content, topError.message);
    return `--- repo: ${sf.repo} path: ${sf.path} ---\n${trimmed}`;
  });

  // Ask AI for fix plan
  const prompt =
    `Jira ticket: ${ctx.ticketKey}\n` +
    `Component: ${ctx.component}\n` +
    `Error (${topError.occurrences}x):\n${topError.stackTrace}\n\n` +
    (sourceContext.length > 0
      ? `Relevant source files:\n${sourceContext.join("\n\n")}`
      : "No source files available — analyze based on the stack trace.");

  startSpinner("AI generating fix plan...");
  const aiResponse = await askAI(prompt, PLAN_SYSTEM_PROMPT);
  stopSpinner();

  // Parse two-section response
  const { analysis, patch: rawPatch } = parseAiPlanResponse(aiResponse);

  // Fix patch paths: ensure --- a/ and +++ b/ lines use the full path from source files
  const fixedPatch = rawPatch ? fixPatchPaths(rawPatch, sourceFiles) : "";

  if (analysis) {
    ctx.fixPlan = {
      affectedFiles: (analysis["affectedFiles"] as string[]) ?? [],
      rootCause: (analysis["rootCause"] as string) ?? aiResponse,
      proposedFix: (analysis["proposedFix"] as string) ?? aiResponse,
      patch: fixedPatch,
    };
  } else {
    ctx.fixPlan = {
      affectedFiles: [],
      rootCause: aiResponse,
      proposedFix: aiResponse,
      patch: fixedPatch,
    };
  }

  // Determine the actual target repo AND project from the patch's file
  // paths. Earlier this only updated sourceFoundInRepo, so a fix in a
  // sibling-project repo (e.g., found via repo-map cache pointing to a
  // non-NRS project) was cloned and pushed under the original project
  // key, producing a 404 or pushing into the wrong project.
  if (fixedPatch) {
    const patchFileMatch = fixedPatch.match(/^---\s+a\/(.+)$/m);
    if (patchFileMatch) {
      const patchFile = patchFileMatch[1]!;
      const matchingSf = sourceFiles.find((sf) => patchFile.endsWith(sf.path) || sf.path.endsWith(patchFile));
      if (matchingSf && (matchingSf.repo !== repo || matchingSf.project !== project)) {
        sourceFoundInRepo = matchingSf.repo;
        sourceFoundInProject = matchingSf.project;
        console.log(`[PLAN] Patch targets file in repo: ${sourceFoundInProject}/${sourceFoundInRepo}`);
      }
    }
  }

  // Track where the source was actually found
  if (sourceFoundInRepo !== repo || sourceFoundInProject !== project) {
    ctx.sourceProject = sourceFoundInProject;
    ctx.sourceRepo = sourceFoundInRepo;
    console.log(`[PLAN] Fix targets different repo: ${sourceFoundInProject}/${sourceFoundInRepo}`);
    // Cache this mapping for future runs
    setMapping(ctx.app, ctx.component, {
      bitbucketProject: sourceFoundInProject,
      bitbucketRepo: sourceFoundInRepo,
      discoveredAt: new Date().toISOString(),
    });
    console.log(`[PLAN] Saved repo mapping: ${ctx.app}/${ctx.component} → ${sourceFoundInProject}/${sourceFoundInRepo}`);
  }

  // Do NOT set ctx.repoPath here. PLAN doesn't yet know the absolute clone
  // path (that's IMPLEMENT's job, anchored at CLONE_BASE). A relative
  // "<project>/<repo>" string would be unsafe to pass as `cwd` to git
  // operations on --resume from later steps. ctx.sourceProject and
  // ctx.sourceRepo carry the routing information IMPLEMENT/CREATE-PR need;
  // ctx.repoPath is set by IMPLEMENT after the clone completes.
  console.log(`\n[PLAN] ── Fix Plan ──────────────────────────────────`);
  console.log(`[PLAN] Files affected: ${ctx.fixPlan.affectedFiles.join(", ")}`);
  console.log(`[PLAN] Root cause:\n  ${ctx.fixPlan.rootCause}`);
  console.log(`[PLAN] Proposed fix:\n  ${ctx.fixPlan.proposedFix}`);
  if (fixedPatch) {
    console.log(`[PLAN] Patch (${fixedPatch.length} chars):\n${fixedPatch}`);
  }
  console.log(`[PLAN] ─────────────────────────────────────────────\n`);
}

/**
 * Extract class names to search for from error message and stack trace.
 * Returns Java file names like "UUIDJAXBAdapter.java".
 */
function extractTargetClasses(message: string, stackTrace: string): Set<string> {
  const classes = new Set<string>();
  const fullText = `${message}\n${stackTrace}`;

  // Exception/Error class names — only from ca.bc.gov packages or log4j class column
  // Skip bare class names from third-party packages (e.g., oracle.stellent.ServiceException)
  const appClassMatches = fullText.matchAll(/\bca\.bc\.gov[\w.]*\.([\w]+(?:Exception|Error|Adapter|Handler|Impl|Service|Filter|Interceptor))\b/g);
  for (const m of appClassMatches) {
    classes.add(`${m[1]!}.java`);
  }
  // Log4j class column (e.g., "ERROR thread-1 UUIDJAXBAdapter:33")
  const log4jMatches = message.matchAll(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\S+\s+([\w]+(?:Adapter|Handler|Impl|Service|Filter|Interceptor|Task|Subtask))\b/g);
  for (const m of log4jMatches) {
    classes.add(`${m[1]!}.java`);
  }

  // Fully qualified class names from stack frames: "at ca.bc.gov.nrs.cwm.Foo.method(Foo.java:42)"
  const frameRegex = /at\s+([\w.]+)\.([\w]+)\(([\w]+\.java):\d+\)/g;
  let match;
  while ((match = frameRegex.exec(fullText)) !== null) {
    const pkg = match[1]!;
    const fileName = match[3]!;
    // Only include our code (ca.bc.gov), not third-party
    if (pkg === "ca.bc.gov" || pkg.startsWith("ca.bc.gov.")) {
      classes.add(fileName);
    }
  }

  // Log4j class references: "ca.bc.gov.nrs.dm.service.v1.impl.FolderServiceImpl"
  const fqcnMatch = fullText.match(/\b(ca\.bc\.gov[\w.]+)\b/g);
  if (fqcnMatch) {
    for (const fqcn of fqcnMatch) {
      const simpleName = fqcn.split(".").pop();
      if (simpleName && simpleName[0]! >= "A" && simpleName[0]! <= "Z") {
        classes.add(`${simpleName}.java`);
      }
    }
  }

  return classes;
}

/** Check if a class name is from the JDK standard library. */
function isStdlibClass(name: string): boolean {
  const stdlib = new Set([
    "IllegalArgumentException", "NullPointerException", "RuntimeException",
    "Exception", "Error", "Throwable", "IOException", "ClassNotFoundException",
    "NoSuchMethodException", "UnsupportedOperationException", "SecurityException",
    "ClassCastException", "ArrayIndexOutOfBoundsException", "NumberFormatException",
    "ConcurrentModificationException", "InterruptedException", "IllegalStateException",
    "StackOverflowError", "OutOfMemoryError",
  ]);
  return stdlib.has(name);
}

/** Check if a repo name looks like a shared library. */
function isLibraryRepo(slug: string): boolean {
  return /(?:generic|common|shared|lib|utils|core)/i.test(slug);
}

/**
 * Read pom.xml from a repo and extract internal dependency artifactIds.
 * Returns repo slugs to search (e.g., "cwm-generic-lib" from artifactId).
 */
async function findDependencyRepos(
  client: BitbucketClient,
  project: string,
  repo: string
): Promise<string[]> {
  const depRepos: string[] = [];

  // Try root pom.xml first, then common Maven module locations
  const pomPaths = ["pom.xml"];

  // Also check for Maven modules — read root pom to find <modules>
  let rootPom = "";
  try {
    rootPom = await client.readFile(project, repo, "pom.xml");
  } catch {
    return depRepos;
  }

  // Extract <module> entries to find sub-module pom.xml files
  const moduleRegex = /<module>([^<]+)<\/module>/g;
  let moduleMatch;
  while ((moduleMatch = moduleRegex.exec(rootPom)) !== null) {
    pomPaths.push(`${moduleMatch[1]}/pom.xml`);
  }

  // Collect all pom content
  const allPomContent = [rootPom];
  for (const pomPath of pomPaths.slice(1)) {
    try {
      const content = await client.readFile(project, repo, pomPath);
      allPomContent.push(content);
    } catch { /* skip */ }
  }

  // Extract internal dependencies (ca.bc.gov group IDs)
  for (const pomContent of allPomContent) {
    // Look for dependencies with ca.bc.gov groupId
    const depRegex = /<dependency>\s*<groupId>(ca\.bc\.gov[^<]*)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/gs;
    let depMatch;
    while ((depMatch = depRegex.exec(pomContent)) !== null) {
      const artifactId = depMatch[2]!;
      // The artifactId is often the repo slug or close to it
      if (!depRepos.includes(artifactId)) {
        depRepos.push(artifactId);
      }
    }

    // Also check <parent> — parent POMs often indicate the project structure
    const parentMatch = pomContent.match(
      /<parent>\s*<groupId>(ca\.bc\.gov[^<]*)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/s
    );
    if (parentMatch) {
      const parentArtifact = parentMatch[2]!;
      if (!depRepos.includes(parentArtifact)) {
        depRepos.push(parentArtifact);
      }
    }
  }

  // Prioritize library-looking repos
  depRepos.sort((a, b) => {
    const aLib = isLibraryRepo(a) ? -1 : 0;
    const bLib = isLibraryRepo(b) ? -1 : 0;
    return aLib - bLib;
  });

  return depRepos;
}

/** Extract Java source file paths from stack trace and log4j error lines. */
function extractFileHints(stackTrace: string, message: string): string[] {
  const hints = new Set<string>();
  const fullText = `${message}\n${stackTrace}`;

  // Match "at com.example.Foo.method(Foo.java:42)"
  const frameRegex = /at\s+([\w.]+)\.([\w]+)\(([\w]+\.java):\d+\)/g;
  let match;
  while ((match = frameRegex.exec(fullText)) !== null) {
    const packagePath = match[1]!.replace(/\./g, "/");
    const fileName = match[3]!;
    hints.add(`src/main/java/${packagePath}/${fileName}`);
  }

  // Match log4j class name: "ca.bc.gov.nrs.dm.service.v1.impl.FolderServiceImpl"
  const classMatch = fullText.match(
    /\b(ca\.bc\.gov[\w.]+(?:Impl|Service|Controller|Handler|Filter))\b/
  );
  if (classMatch) {
    const path = classMatch[1]!.replace(/\./g, "/") + ".java";
    hints.add(`src/main/java/${path}`);
  }

  return Array.from(hints);
}

/**
 * Find files matching target names in a repo using the /files endpoint.
 * Single API call returns a flat recursive file list — much faster than walking the tree.
 */
async function findFilesInRepo(
  client: BitbucketClient,
  project: string,
  repo: string,
  targetNames: Set<string>,
): Promise<string[]> {
  try {
    const allFiles = await client.listFiles(project, repo);
    const found: string[] = [];
    for (const filePath of allFiles) {
      const fileName = filePath.split("/").pop();
      if (fileName && targetNames.has(fileName)) {
        found.push(filePath);
        if (found.length >= 3) break;
      }
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Extract the most relevant portion of a source file for the AI prompt.
 * With Copilot Business models (Claude Sonnet = 200K tokens), we can send
 * much larger context. Limit to ~50K chars (~12K tokens) per file.
 */
function extractRelevantCode(source: string, errorMessage: string): string {
  const MAX_CHARS = 50_000;
  const lines = source.split("\n");

  if (source.length <= MAX_CHARS) return source;

  // Extract keywords from the error message
  const msgWords = errorMessage
    .replace(/[^a-zA-Z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);

  // Find line ranges containing keywords (with context)
  const relevantRanges: Array<[number, number]> = [];
  const CONTEXT = 20;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (msgWords.some((kw) => line.toLowerCase().includes(kw.toLowerCase()))) {
      const start = Math.max(0, i - CONTEXT);
      const end = Math.min(lines.length - 1, i + CONTEXT);
      relevantRanges.push([start, end]);
    }
  }

  if (relevantRanges.length === 0) {
    const head = lines.slice(0, 50).join("\n");
    const tail = lines.slice(-30).join("\n");
    return `${head}\n\n// ... (${lines.length - 80} lines omitted) ...\n\n${tail}`;
  }

  // Merge overlapping ranges
  relevantRanges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [relevantRanges[0]!];
  for (let i = 1; i < relevantRanges.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = relevantRanges[i]!;
    if (curr[0] <= prev[1] + 5) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }

  const parts: string[] = [];
  parts.push(lines.slice(0, 15).join("\n"));

  let lastEnd = 15;
  for (const [start, end] of merged) {
    if (start > lastEnd) {
      parts.push(`\n// ... (lines ${lastEnd + 1}-${start - 1} omitted) ...\n`);
    }
    parts.push(lines.slice(Math.max(start, lastEnd), end + 1).join("\n"));
    lastEnd = end + 1;
  }

  const result = parts.join("\n");
  return result.length <= MAX_CHARS
    ? result
    : result.slice(0, MAX_CHARS) + "\n// ... (truncated)";
}

/**
 * Fix patch paths to use the full path from the repo root.
 * AI models sometimes generate diffs with just the filename or partial path.
 * This maps them back to the full paths found by source discovery.
 */
function fixPatchPaths(
  patch: string,
  sourceFiles: Array<{ path: string; content: string; repo: string }>
): string {
  // Build a map: simple filename → full path from repo root
  const pathMap = new Map<string, string>();
  for (const sf of sourceFiles) {
    const fileName = sf.path.split("/").pop();
    if (fileName) pathMap.set(fileName, sf.path);
    // Also map the path itself
    pathMap.set(sf.path, sf.path);
  }

  // Fix --- a/... and +++ b/... lines
  return patch.replace(
    /^(---|\+\+\+)\s+(a|b)\/(.+)$/gm,
    (_match, prefix: string, ab: string, filePath: string) => {
      const fileName = filePath.split("/").pop()!;
      const fullPath = pathMap.get(filePath) ?? pathMap.get(fileName);
      if (fullPath && fullPath !== filePath) {
        console.log(`[PLAN] Fixed patch path: ${filePath} → ${fullPath}`);
        return `${prefix} ${ab}/${fullPath}`;
      }
      return `${prefix} ${ab}/${filePath}`;
    }
  );
}

/** Parse AI response into JSON analysis + diff patch. */
function parseAiPlanResponse(output: string): {
  analysis: Record<string, unknown> | null;
  patch: string | null;
} {
  const jsonMatch = output.match(/^(\{.*\})\s*$/m);
  let analysis: Record<string, unknown> | null = null;
  if (jsonMatch) {
    try {
      analysis = JSON.parse(jsonMatch[1]!) as Record<string, unknown>;
    } catch {
      const fallback = output.match(/\{[^{}]*"affectedFiles"[^{}]*\}/);
      if (fallback) {
        try { analysis = JSON.parse(fallback[0]) as Record<string, unknown>; } catch { /* skip */ }
      }
    }
  }

  const diffMatch = output.match(/((?:diff --git|--- a\/).+)/s);
  const patch = diffMatch ? diffMatch[1]!.trim() : null;

  return { analysis, patch };
}
