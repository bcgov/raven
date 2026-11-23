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
import { podUsesImage, sanitizeObject, summarizeEvent, summarizePod } from "./sanitize.js";

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

// Cluster-generated identifiers: scrubbing them corrupts names such as
// "app-5d6b1bbf5c-x" or 10-digit pod-template hashes that resemble phone numbers.
const IDENTIFIER_KEYS = new Set([
  "name",
  "generateName",
  "namespace",
  "uid",
  "resourceVersion",
  "image",
  "imageID",
  "containerID",
  "nodeName",
  "node",
  "object",
  "pod-template-hash",
  "controller-revision-hash",
  "statefulset.kubernetes.io/pod-name",
]);

/** Scrub PI from string values only, so keys and JSON structure stay intact. */
function scrubStructured(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key !== undefined && IDENTIFIER_KEYS.has(key) ? value : pi.scrubText(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => scrubStructured(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubStructured(v, k)]));
  }
  return value;
}

function respond(value: unknown): ToolResult {
  let text = typeof value === "string" ? pi.scrubText(value) : JSON.stringify(scrubStructured(value), null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request]`;
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
  return { content: [{ type: "text", text: pi.scrubText(message) }], isError: true };
}

export interface OpenShiftServerOptions {
  /** Injected reader for tests; defaults to the kubeconfig-backed client, created on first use. */
  reader?: OpenShiftReader;
}

export function createOpenShiftServer(options: OpenShiftServerOptions = {}): McpServer {
  const server = new McpServer({ name: "raven-openshift", version: "0.3.0" });
  let reader = options.reader;
  const client = (): OpenShiftReader => (reader ??= new KubeOpenShiftReader());
  const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return respond(await fn());
    } catch (err) {
      return fail(err);
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
        const matches: ReturnType<typeof summarizePod>[] = [];
        let scanned = 0;
        let truncated = false;
        for (const scope of scopes) {
          let continueToken: string | undefined;
          do {
            const page = await client().list("v1", "Pod", { namespace: scope, limit: IMAGE_SCAN_PAGE, continueToken });
            scanned += page.items.length;
            matches.push(...page.items.filter((p) => podUsesImage(p, image)).map(summarizePod));
            continueToken = page.continueToken;
            if (scanned >= IMAGE_SCAN_MAX_PODS && continueToken) {
              truncated = true;
              break;
            }
          } while (continueToken);
          if (truncated) break;
        }
        return { image, scannedPods: scanned, truncated, matches };
      }),
  );

  server.tool(
    "openshift_list_events",
    "List recent events in a project, newest first. Filter by involved object name or Warning type to diagnose rollouts and crashes.",
    {
      namespace: namespaceSchema,
      involvedObjectName: nameSchema.optional().describe("Only events about this object (pod, deployment, …)."),
      type: z.enum(["Normal", "Warning"]).optional(),
      limit: limitSchema(DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
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
        const page = await client().list("v1", "Event", {
          namespace: resolveNamespace(namespace),
          fieldSelector: fieldSelector || undefined,
          limit,
        });
        const events = page.items.map(summarizeEvent).sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""));
        return { events };
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
        const page = await client().list(apiVersion, kind, {
          namespace: resolveNamespace(namespace),
          labelSelector,
          fieldSelector,
          limit,
          continueToken,
        });
        return { items: page.items.map((item) => sanitizeObject(item)), continue: page.continueToken };
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
        const object: KubeObject = await client().get(apiVersion, kind, name, resolveNamespace(namespace));
        return sanitizeObject(object);
      }),
  );

  return server;
}
