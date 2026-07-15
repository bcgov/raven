import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SessionManager,
  createAuthenticatedFetch,
  createBasicAuthFetch,
  PiScrubber,
} from "@nrs/auth";
import { AssetsClient } from "./assets-client.js";
import type { AssetObject } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Scrub PI from asset object attributes that may contain person names.
 * Attributes with "owner", "manager", "contact", "developer", "analyst",
 * "architect", "support", "lead", "admin" in their name are scrubbed.
 */
/**
 * Scrub text through PiScrubber, always returning a string.
 */
function scrub(text: string): string {
  return pi.scrub(text) ?? text;
}

function scrubAssetObject(client: AssetsClient, obj: AssetObject): string {
  const md = client.formatObjectAsMarkdown(obj);
  return scrub(md);
}

/**
 * Format multiple asset objects as a numbered list.
 */
function formatObjectList(
  client: AssetsClient,
  objects: AssetObject[],
  totalCount: number
): string {
  const lines: string[] = [];
  lines.push(`**Found ${totalCount} result(s), showing ${objects.length}:**\n`);
  for (const obj of objects) {
    lines.push(scrubAssetObject(client, obj));
    lines.push("\n---\n");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the Jira Assets MCP server.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createAssetsServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Jira Assets",
      version: "0.1.0",
    },
    {
      instructions: `You have access to tools for querying Jira Assets (Insight) — the CMDB for NRM applications. Use AQL (Asset Query Language) syntax for search_assets queries. All access is READ-ONLY. Common object types: Applications, Application Environments, Technologies, People, ORG (Ministry/Division/Branch/Section), Contracts. If you encounter authentication errors, inform the user they need to set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD environment variables for Basic Auth, or re-authenticate via SMSESSION.${WORKAROUND_NOTE}`,
    }
  );

  let assetsClient: AssetsClient | null = null;

  async function initClient(): Promise<AssetsClient> {
    if (!assetsClient) {
      const email = process.env["ATLASSIAN_EMAIL"];
      const password = process.env["ATLASSIAN_PASSWORD"];
      const baseUrl = process.env["ATLASSIAN_BASE_URL"];

      if (email && password && baseUrl) {
        const authFetch = createBasicAuthFetch(email, password);
        assetsClient = new AssetsClient(authFetch, `${baseUrl}/int/jira`);
      } else {
        const sessionManager = new SessionManager();
        const authFetch = await createAuthenticatedFetch(sessionManager);
        assetsClient = new AssetsClient(authFetch);
      }
    }
    return assetsClient;
  }

  // ---------------------------------------------------------------------------
  // Tool 1: search_assets — Execute an AQL query
  // ---------------------------------------------------------------------------

  server.tool(
    "search_assets",
    `Search Jira Assets using AQL (Asset Query Language). Returns matching asset objects with all attributes.

IMPORTANT: The query MUST be valid AQL syntax — not a bare keyword. Examples:
- objectType = "Applications" AND Name LIKE "RRS"
- objectType = "Applications" AND "Overall Status" = "Active"
- objectType = "Technologies" AND Name LIKE "Oracle"
- objectType = "Application Environments" AND "Environment Type" = "Production"
- Name LIKE "CWM" (searches all object types for a name)

If you just want to look up an application by name, use get_application instead.`,
    {
      query: z
        .string()
        .describe('AQL query string — must be valid AQL syntax (e.g., \'objectType = "Applications" AND Name LIKE "RRS"\'), NOT a bare keyword'),
      schemaId: z
        .number()
        .optional()
        .describe("Schema ID to scope the search (optional). Use list_schemas to find IDs."),
      maxResults: z
        .number()
        .default(25)
        .describe("Maximum results to return (default 25)"),
    },
    { readOnlyHint: true },
    async ({ query, schemaId, maxResults }) => {
      try {
        const client = await initClient();

        // If the query doesn't look like valid AQL (no operators), treat
        // it as a name search to avoid confusing 400 errors.
        let effectiveQuery = query;
        if (!/[=<>]|LIKE|IN\s*\(|HAVING|IS\s+/i.test(query)) {
          const escaped = query.replace(/"/g, '\\"');
          effectiveQuery = `Name LIKE "${escaped}"`;
        }

        const result = await client.searchAql(effectiveQuery, {
          schemaId,
          resultsPerPage: maxResults,
        });

        const text = formatObjectList(
          client,
          result.objectEntries,
          result.totalFilterCount
        );
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching assets: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 2: get_application — Look up an app by name or acronym
  // ---------------------------------------------------------------------------

  server.tool(
    "get_application",
    `Look up an application by name or acronym in the CMDB. Returns all attributes including status, org unit, technologies, environments, and people roles. The label follows the pattern "ACRONYM - Full Name" (e.g., "RRS - Resource Road Submissions").`,
    {
      nameOrKey: z
        .string()
        .describe('Application name or acronym (e.g., "RRS", "CIRRAS", "DMS")'),
    },
    { readOnlyHint: true },
    async ({ nameOrKey }) => {
      try {
        const client = await initClient();
        const app = await client.findApplication(nameOrKey);

        if (!app) {
          return {
            content: [
              {
                type: "text",
                text: `No application found matching "${nameOrKey}". Try a different name or use search_assets with a broader AQL query.`,
              },
            ],
          };
        }

        const text = scrubAssetObject(client, app);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error looking up application: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 3: list_app_environments — Get DEV/TEST/PROD environments for an app
  // ---------------------------------------------------------------------------

  server.tool(
    "list_app_environments",
    `Get DEV/TEST/PROD environment details for an application — URLs, servers, database instances, and environment-specific configuration. Searches Application Environments linked to the given application name.`,
    {
      appName: z
        .string()
        .describe('Application name or acronym (e.g., "RRS")'),
    },
    { readOnlyHint: true },
    async ({ appName }) => {
      try {
        const client = await initClient();
        const escaped = appName.replace(/"/g, '\\"');

        const result = await client.searchAql(
          `objectType = "Application Environments" AND "Application" LIKE "${escaped}"`,
          { resultsPerPage: 25 }
        );

        if (result.objectEntries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No environments found for application "${appName}". The app may not have environments registered in the CMDB, or try a different name.`,
              },
            ],
          };
        }

        const text = formatObjectList(
          client,
          result.objectEntries,
          result.totalFilterCount
        );
        return { content: [{ type: "text", text: `# Environments for ${appName}\n\n${text}` }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching environments: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 4: get_app_people — Get all people roles for an app
  // ---------------------------------------------------------------------------

  server.tool(
    "get_app_people",
    `Get all people associated with an application and their roles — Product Owner, Ministry Portfolio Manager, Developer, Architect, Support, QA, etc. Looks up the application first, then extracts all person-type attributes.`,
    {
      appName: z
        .string()
        .describe('Application name or acronym (e.g., "RRS")'),
    },
    { readOnlyHint: true },
    async ({ appName }) => {
      try {
        const client = await initClient();
        const app = await client.findApplication(appName);

        if (!app) {
          return {
            content: [
              {
                type: "text",
                text: `No application found matching "${appName}".`,
              },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`# People Roles for ${app.label}\n`);

        // Extract person-reference attributes
        const personKeywords = [
          "owner", "manager", "developer", "analyst", "architect",
          "support", "lead", "admin", "contact", "director",
          "coordinator", "tester", "qa", "scrum", "sponsor",
        ];

        let foundPeople = false;
        for (const attr of app.attributes) {
          const name = attr.objectTypeAttribute?.name ?? "";
          const nameLower = name.toLowerCase();

          // Check if this attribute likely contains person references
          const isPersonAttr =
            personKeywords.some((kw) => nameLower.includes(kw)) ||
            attr.objectAttributeValues.some((v) => v.referencedObject?.objectType?.name === "People");

          if (isPersonAttr && attr.objectAttributeValues.length > 0) {
            const values = attr.objectAttributeValues
              .map((v) => {
                if (v.referencedObject) return scrub(v.referencedObject.label);
                return scrub(v.displayValue ?? String(v.value));
              })
              .join(", ");
            lines.push(`- **${name}:** ${values}`);
            foundPeople = true;
          }
        }

        if (!foundPeople) {
          lines.push("*No people roles found for this application.*");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching people: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 5: get_app_technologies — Get technology stack for an app
  // ---------------------------------------------------------------------------

  server.tool(
    "get_app_technologies",
    `Get the technology stack for an application from the CMDB — languages, frameworks, databases, servers, etc.`,
    {
      appName: z
        .string()
        .describe('Application name or acronym (e.g., "RRS")'),
    },
    { readOnlyHint: true },
    async ({ appName }) => {
      try {
        const client = await initClient();
        const app = await client.findApplication(appName);

        if (!app) {
          return {
            content: [
              {
                type: "text",
                text: `No application found matching "${appName}".`,
              },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`# Technologies for ${app.label}\n`);

        // Extract technology-reference attributes
        const techKeywords = [
          "technolog", "language", "framework", "database", "server",
          "platform", "middleware", "runtime", "hosting", "infrastructure",
        ];

        let foundTech = false;
        for (const attr of app.attributes) {
          const name = attr.objectTypeAttribute?.name ?? "";
          const nameLower = name.toLowerCase();

          const isTechAttr =
            techKeywords.some((kw) => nameLower.includes(kw)) ||
            attr.objectAttributeValues.some((v) => v.referencedObject?.objectType?.name === "Technologies");

          if (isTechAttr && attr.objectAttributeValues.length > 0) {
            const values = attr.objectAttributeValues
              .map((v) => {
                if (v.referencedObject) return v.referencedObject.label;
                return v.displayValue ?? String(v.value);
              })
              .join(", ");
            lines.push(`- **${name}:** ${values}`);
            foundTech = true;
          }
        }

        if (!foundTech) {
          lines.push("*No technologies found for this application. Technologies may not be registered in the CMDB.*");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching technologies: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 6: find_apps_by_technology — Find all apps using a technology
  // ---------------------------------------------------------------------------

  server.tool(
    "find_apps_by_technology",
    `Find all applications using a specific technology (e.g., "Oracle Database", "Struts", "Log4j", "Java 8"). Useful for CVE impact assessment, technology currency audits, and migration planning.`,
    {
      technology: z
        .string()
        .describe('Technology name to search for (e.g., "Oracle Database", "Struts", "Log4j")'),
      maxResults: z
        .number()
        .default(50)
        .describe("Maximum results to return (default 50)"),
    },
    { readOnlyHint: true },
    async ({ technology, maxResults }) => {
      try {
        const client = await initClient();
        const escaped = technology.replace(/"/g, '\\"');

        const result = await client.searchAql(
          `objectType = "Applications" AND "Technologies" LIKE "${escaped}"`,
          { resultsPerPage: maxResults }
        );

        if (result.objectEntries.length === 0) {
          // Try a broader search on any attribute
          const broader = await client.searchAql(
            `objectType = "Applications" AND label LIKE "${escaped}"`,
            { resultsPerPage: maxResults }
          );
          if (broader.objectEntries.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No applications found using technology "${technology}". Try a different technology name or use search_assets with a custom AQL query.`,
                },
              ],
            };
          }
          const text = formatObjectList(client, broader.objectEntries, broader.totalFilterCount);
          return { content: [{ type: "text", text: `# Applications matching "${technology}" (broad search)\n\n${text}` }] };
        }

        const text = formatObjectList(
          client,
          result.objectEntries,
          result.totalFilterCount
        );
        return { content: [{ type: "text", text: `# Applications using "${technology}"\n\n${text}` }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching by technology: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 7: find_apps_by_person — Find all apps associated with a person
  // ---------------------------------------------------------------------------

  server.tool(
    "find_apps_by_person",
    `Find all applications associated with a person in any role (Product Owner, Developer, Architect, Support, etc.). Useful for understanding someone's portfolio, planning handoffs, or contractor offboarding impact assessment.`,
    {
      personName: z
        .string()
        .describe('Person name to search for (e.g., "Smith" or "John Smith")'),
      maxResults: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Maximum applications to return per person (1-200, default 50)"),
      maxPeople: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Maximum matching People to scan (1-200, default 50). Raise for very common surnames; lower to short-circuit ambiguous matches."),
    },
    { readOnlyHint: true },
    async ({ personName, maxResults, maxPeople }) => {
      try {
        const client = await initClient();
        const escaped = personName.replace(/"/g, '\\"');

        // Look up the person first so we can disambiguate and report which
        // person matched. AQL's `object HAVING outboundReferences(...)` works
        // off objectKey, so we need it anyway.
        const people = await client.searchAql(
          `objectType = "People" AND Name LIKE "${escaped}"`,
          { resultsPerPage: maxPeople }
        );

        if (people.objectEntries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: scrub(`No People object found matching "${personName}". The person may not be in the CMDB, or try a different name spelling.`),
              },
            ],
          };
        }

        const peopleTruncated = people.totalFilterCount > people.objectEntries.length;

        // Aggregate apps across all matching people (in case of duplicates or
        // partial-name matches like "Smith"). Run the per-person AQL lookups
        // in parallel — they're independent reads — but cap concurrency so a
        // burst of `maxPeople`=200 doesn't slam the Assets API or trip rate
        // limits. 5 in flight is enough to overlap network I/O comfortably
        // while staying predictable on the server side.
        const appsByKey = new Map<string, { app: AssetObject; personLabels: Set<string> }>();
        const CONCURRENCY = 5;
        const perPersonResults: Array<{ person: AssetObject; result: Awaited<ReturnType<typeof client.searchAql>> }> = [];
        for (let i = 0; i < people.objectEntries.length; i += CONCURRENCY) {
          const chunk = people.objectEntries.slice(i, i + CONCURRENCY);
          const chunkResults = await Promise.all(
            chunk.map((person) =>
              client.searchAql(
                `objectType = "Applications" AND object HAVING outboundReferences(objectKey = "${person.objectKey}")`,
                { resultsPerPage: maxResults }
              ).then((result) => ({ person, result }))
            )
          );
          perPersonResults.push(...chunkResults);
        }
        // Track people whose per-person AQL response was itself truncated by
        // maxResults — that means they reference more apps than we fetched,
        // and the aggregate is therefore partial in a hidden way.
        const perPersonTruncated: Array<{ label: string; total: number; fetched: number }> = [];
        for (const { person, result } of perPersonResults) {
          if (result.totalFilterCount > result.objectEntries.length) {
            perPersonTruncated.push({
              label: person.label,
              total: result.totalFilterCount,
              fetched: result.objectEntries.length,
            });
          }
          for (const app of result.objectEntries) {
            const existing = appsByKey.get(app.objectKey);
            if (existing) {
              existing.personLabels.add(person.label);
            } else {
              appsByKey.set(app.objectKey, {
                app,
                personLabels: new Set([person.label]),
              });
            }
          }
        }

        if (appsByKey.size === 0) {
          const matched = people.objectEntries.map((p) => scrub(p.label)).join(", ");
          const truncNote = peopleTruncated
            ? ` (truncated from ${people.totalFilterCount} matches — raise maxPeople to see more)`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Found ${people.objectEntries.length} matching People${truncNote} (${matched}) but none are referenced by any Application in the CMDB.`,
              },
            ],
          };
        }

        const matched = people.objectEntries.map((p) => scrub(p.label)).join(", ");
        const truncNote = peopleTruncated
          ? ` (truncated from ${people.totalFilterCount} matches — raise maxPeople to see more)`
          : "";
        // Cap the rendered output regardless of maxPeople × maxResults.
        // With both maxed (200×200=40k apps), the full rendered markdown
        // would blow past MCP context limits. 200 unique apps is plenty
        // for a "show me everything X touches" query.
        const RENDER_CAP = 200;
        const allApps = [...appsByKey.values()];
        const renderedApps = allApps.slice(0, RENDER_CAP);
        const renderTruncated = allApps.length > RENDER_CAP;

        const lines: string[] = [];
        lines.push(`# Applications referencing ${personName}\n`);
        lines.push(`Matched ${people.objectEntries.length} person(s)${truncNote}: ${matched}\n`);
        // Warn when ANY per-person query was truncated by maxResults — the
        // aggregate "found N application(s)" is then partial in a way that
        // isn't visible from the displayed cardinality alone.
        if (perPersonTruncated.length > 0) {
          const examples = perPersonTruncated
            .slice(0, 5)
            .map((p) => `${scrub(p.label)} (showed ${p.fetched} of ${p.total})`)
            .join("; ");
          const more = perPersonTruncated.length > 5 ? ` and ${perPersonTruncated.length - 5} more` : "";
          lines.push(
            `_⚠ Per-person results truncated for ${perPersonTruncated.length} person(s): ${examples}${more}. Raise maxResults to capture all referenced applications._\n`
          );
        }
        const renderHeader = renderTruncated
          ? `Found ${appsByKey.size} application(s) — rendering first ${RENDER_CAP}:`
          : `Found ${appsByKey.size} application(s):`;
        lines.push(`${renderHeader}\n`);
        for (const { app, personLabels } of renderedApps) {
          const via = personLabels.size > 1
            ? ` _(via ${[...personLabels].map((l) => scrub(l)).join(", ")})_`
            : "";
          lines.push(scrubAssetObject(client, app) + via);
          lines.push("\n---\n");
        }
        if (renderTruncated) {
          lines.push(
            `\n_${appsByKey.size - RENDER_CAP} more application(s) matched but were not rendered to stay within MCP context limits. Narrow the search (more specific personName, lower maxPeople, or filter via search_assets) to see the rest._`
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching by person: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 8: find_apps_by_org — Find apps by organizational unit
  // ---------------------------------------------------------------------------

  server.tool(
    "find_apps_by_org",
    `Find applications by organizational unit — Ministry, Division, Branch, or Section. Useful for portfolio reporting, understanding which apps belong to which part of the organization.`,
    {
      ministry: z
        .string()
        .optional()
        .describe('Ministry name (e.g., "Forests")'),
      division: z
        .string()
        .optional()
        .describe('Division name (e.g., "Digital Services")'),
      branch: z
        .string()
        .optional()
        .describe('Branch name'),
      maxResults: z
        .number()
        .default(50)
        .describe("Maximum results to return (default 50)"),
    },
    { readOnlyHint: true },
    async ({ ministry, division, branch, maxResults }) => {
      try {
        const client = await initClient();

        // Build AQL query from provided org filters
        const conditions: string[] = ['objectType = "Applications"'];

        if (ministry) {
          const escaped = ministry.replace(/"/g, '\\"');
          conditions.push(`"Ministry" LIKE "${escaped}"`);
        }
        if (division) {
          const escaped = division.replace(/"/g, '\\"');
          conditions.push(`"Division" LIKE "${escaped}"`);
        }
        if (branch) {
          const escaped = branch.replace(/"/g, '\\"');
          conditions.push(`"Branch" LIKE "${escaped}"`);
        }

        if (conditions.length === 1) {
          return {
            content: [
              {
                type: "text",
                text: "Please provide at least one organizational filter (ministry, division, or branch).",
              },
            ],
          };
        }

        const query = conditions.join(" AND ");
        const result = await client.searchAql(query, {
          resultsPerPage: maxResults,
        });

        if (result.objectEntries.length === 0) {
          const orgDesc = [ministry, division, branch]
            .filter(Boolean)
            .join(" > ");
          return {
            content: [
              {
                type: "text",
                text: `No applications found for org "${orgDesc}". The organizational hierarchy may use different naming in the CMDB. Try search_assets with a custom AQL query.`,
              },
            ],
          };
        }

        const orgDesc = [ministry, division, branch]
          .filter(Boolean)
          .join(" > ");
        const text = formatObjectList(
          client,
          result.objectEntries,
          result.totalFilterCount
        );
        return { content: [{ type: "text", text: `# Applications in ${orgDesc}\n\n${text}` }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching by org: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 9: get_app_connected_tickets — Get Jira tickets linked to an asset
  // ---------------------------------------------------------------------------

  server.tool(
    "get_app_connected_tickets",
    `Get Jira tickets linked to an application asset — shows active work, incidents, and change requests. Useful for understanding current activity around an app.`,
    {
      appName: z
        .string()
        .describe('Application name or acronym (e.g., "RRS")'),
    },
    { readOnlyHint: true },
    async ({ appName }) => {
      try {
        const client = await initClient();
        const app = await client.findApplication(appName);

        if (!app) {
          return {
            content: [
              {
                type: "text",
                text: `No application found matching "${appName}".`,
              },
            ],
          };
        }

        const ticketData = await client.getObjectConnectedTickets(app.id);
        const lines: string[] = [];
        lines.push(`# Connected Tickets for ${app.label}\n`);

        if (ticketData.tickets.length === 0) {
          lines.push("*No Jira tickets are linked to this asset.*");
        } else {
          lines.push(`**${ticketData.tickets.length} linked ticket(s):**\n`);
          for (const ticket of ticketData.tickets) {
            const url = `${client.baseUrl}/browse/${ticket.key}`;
            const status = typeof ticket.status === "object" && ticket.status !== null
              ? (ticket.status as Record<string, string>).name ?? "Unknown"
              : String(ticket.status);
            const type = typeof ticket.type === "object" && ticket.type !== null
              ? (ticket.type as Record<string, string>).name ?? "Unknown"
              : String(ticket.type);
            lines.push(
              `- **[${ticket.key}](${url})** ${ticket.title} [${status}] (${type})`
            );
          }
        }

        return { content: [{ type: "text", text: scrub(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching connected tickets: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 10: get_object — Look up an object by numeric ID
  // ---------------------------------------------------------------------------

  server.tool(
    "get_object",
    `Look up a single asset object by its numeric ID. Returns full attributes formatted as markdown. Useful when you have an object ID (from an earlier search or a connected ticket) and want the canonical record.`,
    {
      objectId: z.number().describe("Numeric object ID (not the objectKey)"),
    },
    { readOnlyHint: true },
    async ({ objectId }) => {
      try {
        const client = await initClient();
        const obj = await client.getObject(objectId);
        return { content: [{ type: "text", text: scrubAssetObject(client, obj) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error fetching object ${objectId}: ${safeErr(err)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 11: get_object_attributes — Get raw attribute list for an object
  // ---------------------------------------------------------------------------

  server.tool(
    "get_object_attributes",
    `Get the full list of attributes for an asset object as raw key/value pairs. More detail than get_object — includes attribute IDs, types, and references useful when you need to disambiguate attributes with similar names.`,
    {
      objectId: z.number().describe("Numeric object ID"),
    },
    { readOnlyHint: true },
    async ({ objectId }) => {
      try {
        const client = await initClient();
        const attrs = await client.getObjectAttributes(objectId);
        if (attrs.length === 0) {
          return { content: [{ type: "text", text: `Object ${objectId} has no attributes.` }] };
        }
        const lines: string[] = [];
        lines.push(`# Attributes for object ${objectId} (${attrs.length})\n`);
        for (const attr of attrs) {
          const name = attr.objectTypeAttribute?.name ?? `Attribute ${attr.id}`;
          const values = attr.objectAttributeValues
            .map((v) => v.referencedObject?.label ?? v.displayValue ?? String(v.value))
            .join(", ");
          if (values) lines.push(`- **${name}** (id ${attr.id}): ${values}`);
        }
        return { content: [{ type: "text", text: scrub(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error fetching attributes for object ${objectId}: ${safeErr(err)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 12: get_object_history — Get change history for an object
  // ---------------------------------------------------------------------------

  server.tool(
    "get_object_history",
    `Get the change history for an asset object — who changed which attribute, from what to what, and when. Useful for audit and "when did this stop pointing to X" investigations.`,
    {
      objectId: z.number().describe("Numeric object ID"),
      limit: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Maximum entries to return (default 50, newest first)"),
    },
    { readOnlyHint: true },
    async ({ objectId, limit }) => {
      try {
        const client = await initClient();
        const history = await client.getObjectHistory(objectId);
        if (history.length === 0) {
          return { content: [{ type: "text", text: `Object ${objectId} has no recorded history.` }] };
        }
        const sorted = history
          .slice()
          .sort((a, b) => b.created.localeCompare(a.created))
          .slice(0, limit);
        const lines: string[] = [];
        lines.push(`# History for object ${objectId} (${history.length} total entries, showing ${sorted.length})\n`);
        for (const entry of sorted) {
          const date = entry.created.split("T")[0];
          const actor = scrub(entry.actor.displayName);
          const oldVal = entry.oldValue ? scrub(entry.oldValue) : "—";
          const newVal = entry.newValue ? scrub(entry.newValue) : "—";
          lines.push(`- **${date}** ${actor} — ${entry.affectedAttribute}: ${oldVal} → ${newVal}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error fetching history for object ${objectId}: ${safeErr(err)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 13: list_schemas — List all object schemas in the CMDB
  // ---------------------------------------------------------------------------

  server.tool(
    "list_schemas",
    `List all asset object schemas in the CMDB. Each schema groups a set of object types (e.g., the NRM Applications schema, the Server inventory schema). Use the schema ID with search_assets or list_object_types to scope queries.`,
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const client = await initClient();
        const schemas = await client.listSchemas();
        if (schemas.length === 0) {
          return { content: [{ type: "text", text: "No schemas accessible." }] };
        }
        const lines = schemas.map((s) => {
          const counts = [
            s.objectTypeCount !== undefined ? `${s.objectTypeCount} types` : null,
            s.objectCount !== undefined ? `${s.objectCount} objects` : null,
          ].filter(Boolean).join(", ");
          const desc = s.description ? `\n  ${s.description}` : "";
          return `- **${s.name}** (key: ${s.objectSchemaKey}, id: ${s.id})${counts ? ` — ${counts}` : ""}${desc}`;
        });
        return {
          content: [{ type: "text", text: `# Asset Schemas (${schemas.length})\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing schemas: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 14: list_object_types — List object types within a schema
  // ---------------------------------------------------------------------------

  server.tool(
    "list_object_types",
    `List object types within a schema — e.g., for the NRM Applications schema, this returns "Applications", "Application Environments", "Technologies", "People", etc. Use list_schemas first to find the schema ID.`,
    {
      schemaId: z.number().describe("Schema ID (from list_schemas)"),
    },
    { readOnlyHint: true },
    async ({ schemaId }) => {
      try {
        const client = await initClient();
        const types = await client.listObjectTypes(schemaId);
        if (types.length === 0) {
          return { content: [{ type: "text", text: `Schema ${schemaId} has no object types.` }] };
        }
        const lines = types.map((t) => {
          const count = t.objectCount !== undefined ? ` — ${t.objectCount} objects` : "";
          const desc = t.description ? `\n  ${t.description}` : "";
          return `- **${t.name}** (id: ${t.id})${count}${desc}`;
        });
        return {
          content: [
            { type: "text", text: `# Object Types in schema ${schemaId} (${types.length})\n\n${lines.join("\n")}` },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error listing object types for schema ${schemaId}: ${safeErr(err)}` },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
