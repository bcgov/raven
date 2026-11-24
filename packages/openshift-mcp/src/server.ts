import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiException } from "@kubernetes/client-node";
import { PiScrubber } from "@nrs/auth";
import { KubeOpenShiftReader, type KubeObject, type OpenShiftReader } from "./openshift-client.js";
import {
  allowedNamespaces,
  assertAllowedKind,
  isValidApiVersion,
  isValidKind,
  isValidName,
  isValidNamespace,
  resolveNamespace,
} from "./policy.js";
import { podUsesImage, redactPrivateKeys, sanitizeObject, summarizeEvent, summarizePod } from "./sanitize.js";

const pi = new PiScrubber();

const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_RESOURCE_LIMIT = 20;
const MAX_RESOURCE_LIMIT = 100;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 2_000;
const MAX_LOG_BYTES = 256 * 1024;
const IMAGE_SCAN_PAGE = 500;
const IMAGE_SCAN_MAX_PODS = 5_000;
const EVENT_SCAN_PAGE = 500;
const EVENT_SCAN_MAX = 5_000;
const READ_ONLY = { readOnlyHint: true } as const;

const namespaceSchema = z.string().refine(isValidNamespace, "must be a valid OpenShift project/namespace name");
const nameSchema = z.string().refine(isValidName, "must be a valid Kubernetes object name");
const apiVersionSchema = z
  .string()
  .refine(isValidApiVersion, 'must look like "v1" or "apps/v1"')
  .describe('API version, e.g. "v1", "apps/v1", "apps.openshift.io/v1", "build.openshift.io/v1".');
const kindSchema = z
  .string()
  .refine(isValidKind, 'must be a PascalCase kind such as "Deployment"')
  .describe('Kind, e.g. "Deployment", "ReplicaSet", "DeploymentConfig", "BuildConfig", "Build", "ImageStream", "Route".');
const selectorSchema = (what: string) =>
  z.string().max(512).optional().describe(`Kubernetes ${what} selector, e.g. "app=my-api".`);
const limitSchema = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def).describe(`Maximum items per page (default ${def}, max ${max}).`);
const continueSchema = z.string().max(4096).optional().describe("`continue` token from the previous page.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// Cluster-generated identifiers, keyed by the field that contains them. Scrubbing
// them corrupts names such as "app-5d6b1bbf5c-x" or 10-digit pod-template hashes
// that resemble phone numbers. Matching on the parent field keeps user-controlled
// payloads (ConfigMap data, annotations, …) scrubbed even when keys collide.
const IDENTIFIER_FIELDS = new Map<string, Set<string>>([
  ["", new Set(["image"])],
  ["metadata", new Set(["name", "generateName", "namespace", "uid", "resourceVersion"])],
  ["ownerReferences", new Set(["kind", "name", "uid"])],
  ["owners", new Set(["kind", "name"])],
  ["spec", new Set(["nodeName"])],
  ["labels", new Set(["pod-template-hash", "controller-revision-hash", "statefulset.kubernetes.io/pod-name"])],
  ["pods", new Set(["name", "namespace", "node"])],
  ["matches", new Set(["name", "namespace", "node"])],
  ["projects", new Set(["name"])],
  ["events", new Set(["object"])],
  ...["containers", "initContainers", "ephemeralContainers"].map(
    (field) => [field, new Set(["name", "image", "imageID"])] as const,
  ),
  ...["containerStatuses", "initContainerStatuses", "ephemeralContainerStatuses"].map(
    (field) => [field, new Set(["name", "image", "imageID", "containerID"])] as const,
  ),
]);

function scrubText(text: string): string {
  return pi.scrubText(redactPrivateKeys(text));
}

/** Scrub PI from string values only, so keys and JSON structure stay intact. */
function scrubStructured(value: unknown, parent = "", key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && IDENTIFIER_FIELDS.get(parent)?.has(key) ? value : scrubText(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => scrubStructured(item, parent, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubStructured(v, key ?? "", k)]));
  }
  return value;
}

function respond(value: unknown): ToolResult {
  if (typeof value !== "string") {
    const text = JSON.stringify(scrubStructured(value), null, 2);
    if (text.length > MAX_OUTPUT_CHARS) {
      throw new Error(
        `OpenShift response is ${text.length} characters, over the ${MAX_OUTPUT_CHARS}-character limit; ` +
          "narrow the request (namespace, selector) or lower the page limit.",
      );
    }
    return { content: [{ type: "text", text }] };
  }
  let text = scrubText(value);
  if (text.length > MAX_OUTPUT_CHARS) {
    const suffix = `\n\n[truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request]`;
    text = text.slice(0, MAX_OUTPUT_CHARS - suffix.length) + suffix;
  }
  return { content: [{ type: "text", text }] };
}

function apiErrorMessage(err: ApiException<unknown>): string {
  let detail = "";
  const body = typeof err.body === "string" ? safeParse(err.body) : err.body;
  if (body && typeof body === "object" && "message" in body) detail = String(body.message);
  const hint =
    err.code === 401
      ? " Your OpenShift login has expired or is missing; run `oc login`."
      : err.code === 403
        ? " The OpenShift identity lacks RBAC permission for this read."
        : "";
  return `OpenShift API error ${err.code}${detail ? `: ${detail}` : ""}.${hint}`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof ApiException ? apiErrorMessage(err) : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: scrubText(message) }], isError: true };
}

export interface OpenShiftServerOptions {
  /** Injected reader for tests; never replaced. */
  reader?: OpenShiftReader;
  /** Creates the kubeconfig-backed reader on first use and again after a 401, so a fresh `oc login` takes effect. */
  readerFactory?: () => OpenShiftReader;
}

export function createOpenShiftServer(options: OpenShiftServerOptions = {}): McpServer {
  const server = new McpServer({ name: "raven-openshift", version: "0.3.0" });
  const createReader = options.readerFactory ?? (() => new KubeOpenShiftReader());
  let reader = options.reader;
  const client = (): OpenShiftReader => (reader ??= createReader());
  const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return respond(await fn());
    } catch (err) {
      if (!options.reader && err instanceof ApiException && err.code === 401) reader = undefined;
      return fail(err);
    }
  };
  /** With an allowlist, a namespace argument must not unlock cluster-scoped kinds such as Node. */
  const assertNamespaceScoped = async (apiVersion: string, kind: string): Promise<void> => {
    if (allowedNamespaces() && !(await client().isNamespaced(apiVersion, kind))) {
      throw new Error(
        `${kind} (${apiVersion}) is cluster-scoped; cluster-scoped reads are disabled while OPENSHIFT_ALLOWED_NAMESPACES is set.`,
      );
    }
  };

  server.tool(
    "openshift_list_projects",
    "List OpenShift projects the configured identity can see (filtered to OPENSHIFT_ALLOWED_NAMESPACES when set).",
    { limit: limitSchema(DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT), continue: continueSchema },
    READ_ONLY,
    ({ limit, continue: continueToken }) =>
      run(async () => {
        const allowed = allowedNamespaces();
        const page = await client().list("project.openshift.io/v1", "Project", { limit, continueToken });
        const projects = page.items
          .filter((p) => !allowed || allowed.includes(p.metadata?.name ?? ""))
          .map((p) => ({
            name: p.metadata?.name,
            displayName: p.metadata?.annotations?.["openshift.io/display-name"],
            phase: (p["status"] as { phase?: string } | undefined)?.phase,
          }));
        return { projects, continue: page.continueToken };
      }),
  );

  server.tool(
    "openshift_list_pods",
    "List pods in a project with phase, readiness, restarts, owners and each container's image and resolved digest (imageID).",
    {
      namespace: namespaceSchema.describe("Project/namespace."),
      labelSelector: selectorSchema("label"),
      limit: limitSchema(DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
      continue: continueSchema,
    },
    READ_ONLY,
    ({ namespace, labelSelector, limit, continue: continueToken }) =>
      run(async () => {
        const ns = resolveNamespace(namespace);
        const page = await client().list("v1", "Pod", { namespace: ns, labelSelector, limit, continueToken });
        return { pods: page.items.map(summarizePod), continue: page.continueToken };
      }),
  );

  server.tool(
    "openshift_get_pod",
    "Get one pod's full spec and status (managedFields and credential-like env values removed).",
    { namespace: namespaceSchema, name: nameSchema },
    READ_ONLY,
    ({ namespace, name }) =>
      run(async () => sanitizeObject(await client().get("v1", "Pod", name, resolveNamespace(namespace)))),
  );

  server.tool(
    "openshift_find_pods_by_image",
    "Find running pods whose image reference or resolved digest contains the given value. Use a Sysdig image digest " +
      '("sha256:…") or repository to map a vulnerability finding to its deployed workloads and owners.',
    {
      image: z
        .string()
        .min(8)
        .max(512)
        .describe('Image digest ("sha256:…"), full reference, or repository substring (at least 8 characters).'),
      namespace: namespaceSchema
        .optional()
        .describe("Limit to one project. Omit to search every allowed project, or the whole cluster if no allowlist is set."),
    },
    READ_ONLY,
    ({ image, namespace }) =>
      run(async () => {
        const allowed = allowedNamespaces();
        const scopes: (string | undefined)[] = namespace
          ? [resolveNamespace(namespace, allowed)]
          : allowed ?? [undefined];
        const label = (scope: string | undefined) => scope ?? "(all namespaces)";
        const matches: ReturnType<typeof summarizePod>[] = [];
        const incompleteNamespaces: string[] = [];
        let scanned = 0;
        for (const [index, scope] of scopes.entries()) {
          if (scanned >= IMAGE_SCAN_MAX_PODS) {
            incompleteNamespaces.push(...scopes.slice(index).map(label));
            break;
          }
          let continueToken: string | undefined;
          do {
            const limit = Math.min(IMAGE_SCAN_PAGE, IMAGE_SCAN_MAX_PODS - scanned);
            const page = await client().list("v1", "Pod", { namespace: scope, limit, continueToken });
            scanned += page.items.length;
            matches.push(...page.items.filter((p) => podUsesImage(p, image)).map(summarizePod));
            continueToken = page.continueToken;
          } while (continueToken && scanned < IMAGE_SCAN_MAX_PODS);
          if (continueToken) incompleteNamespaces.push(label(scope));
        }
        return {
          image,
          scannedPods: scanned,
          truncated: incompleteNamespaces.length > 0,
          ...(incompleteNamespaces.length
            ? { incompleteNamespaces, note: `Stopped after scanning ${IMAGE_SCAN_MAX_PODS} pods; pass a namespace to search the rest.` }
            : {}),
          matches,
        };
      }),
  );

  server.tool(
    "openshift_list_events",
    "List the most recent events in a project, newest first. Filter by involved object name or Warning type to diagnose rollouts and crashes.",
    {
      namespace: namespaceSchema,
      involvedObjectName: nameSchema.optional().describe("Only events about this object (pod, deployment, …)."),
      type: z.enum(["Normal", "Warning"]).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .default(DEFAULT_LIST_LIMIT)
        .describe(`Maximum events to return after sorting newest first (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`),
    },
    READ_ONLY,
    ({ namespace, involvedObjectName, type, limit }) =>
      run(async () => {
        const fieldSelector = [
          involvedObjectName ? `involvedObject.name=${involvedObjectName}` : "",
          type ? `type=${type}` : "",
        ]
          .filter(Boolean)
          .join(",");
        const ns = resolveNamespace(namespace);
        // The API returns events in name order, so read every page before choosing the newest.
        const items: KubeObject[] = [];
        let continueToken: string | undefined;
        do {
          const page = await client().list("v1", "Event", {
            namespace: ns,
            fieldSelector: fieldSelector || undefined,
            limit: Math.min(EVENT_SCAN_PAGE, EVENT_SCAN_MAX - items.length),
            continueToken,
          });
          items.push(...page.items);
          continueToken = page.continueToken;
        } while (continueToken && items.length < EVENT_SCAN_MAX);
        const time = (value: string | undefined) => (value ? Date.parse(value) || 0 : 0);
        const events = items
          .map(summarizeEvent)
          .sort((a, b) => time(b.last) - time(a.last))
          .slice(0, limit);
        return {
          events,
          scannedEvents: items.length,
          ...(continueToken
            ? { truncated: true, note: `Only the first ${EVENT_SCAN_MAX} events were scanned; filter by object or type for complete results.` }
            : {}),
        };
      }),
  );

  server.tool(
    "openshift_get_pod_logs",
    "Get the tail of a pod container's logs (PI-scrubbed). Use previous=true for a crashed container's last run.",
    {
      namespace: namespaceSchema,
      name: nameSchema.describe("Pod name."),
      container: nameSchema.optional().describe("Container name; required when the pod has several."),
      tailLines: z.number().int().min(1).max(MAX_TAIL_LINES).default(DEFAULT_TAIL_LINES),
      sinceSeconds: z.number().int().min(1).max(7 * 24 * 3600).optional(),
      previous: z.boolean().default(false),
    },
    READ_ONLY,
    ({ namespace, name, container, tailLines, sinceSeconds, previous }) =>
      run(async () => {
        const log = await client().podLog(resolveNamespace(namespace) as string, name, {
          container,
          tailLines,
          sinceSeconds,
          previous,
          limitBytes: MAX_LOG_BYTES,
        });
        return log === "" ? "(no log output)" : log;
      }),
  );

  server.tool(
    "openshift_list_resources",
    "List objects of any readable kind (Deployment, DeploymentConfig, ReplicaSet, BuildConfig, Build, ImageStream, Route, …). " +
      "Secrets, ServiceAccounts, RBAC, OAuth and user/identity kinds are blocked.",
    {
      apiVersion: apiVersionSchema,
      kind: kindSchema,
      namespace: namespaceSchema.optional().describe("Project/namespace; omit for cluster-scoped kinds."),
      labelSelector: selectorSchema("label"),
      fieldSelector: selectorSchema("field"),
      limit: limitSchema(DEFAULT_RESOURCE_LIMIT, MAX_RESOURCE_LIMIT),
      continue: continueSchema,
    },
    READ_ONLY,
    ({ apiVersion, kind, namespace, labelSelector, fieldSelector, limit, continue: continueToken }) =>
      run(async () => {
        assertAllowedKind(apiVersion, kind);
        const ns = resolveNamespace(namespace);
        await assertNamespaceScoped(apiVersion, kind);
        // Re-request smaller pages instead of slicing JSON, so output stays parseable
        // and the continue token still points at the first unreturned object.
        for (let pageSize = limit; ; pageSize = Math.max(1, Math.floor(pageSize / 2))) {
          const page = await client().list(apiVersion, kind, {
            namespace: ns,
            labelSelector,
            fieldSelector,
            limit: pageSize,
            continueToken,
          });
          const result = {
            items: page.items.map((item) => sanitizeObject(item)),
            continue: page.continueToken,
            ...(pageSize < limit ? { note: `Page reduced to ${pageSize} item(s) to fit the output limit.` } : {}),
          };
          if (pageSize === 1 || JSON.stringify(scrubStructured(result), null, 2).length <= MAX_OUTPUT_CHARS) return result;
        }
      }),
  );

  server.tool(
    "openshift_get_resource",
    "Get one object of any readable kind, e.g. a Deployment's image and rollout status or a Build's source commit. " +
      "Secrets, ServiceAccounts, RBAC, OAuth and user/identity kinds are blocked.",
    {
      apiVersion: apiVersionSchema,
      kind: kindSchema,
      name: nameSchema,
      namespace: namespaceSchema.optional().describe("Project/namespace; omit for cluster-scoped kinds."),
    },
    READ_ONLY,
    ({ apiVersion, kind, name, namespace }) =>
      run(async () => {
        assertAllowedKind(apiVersion, kind);
        const ns = resolveNamespace(namespace);
        await assertNamespaceScoped(apiVersion, kind);
        const object: KubeObject = await client().get(apiVersion, kind, name, ns);
        return sanitizeObject(object);
      }),
  );

  return server;
}
