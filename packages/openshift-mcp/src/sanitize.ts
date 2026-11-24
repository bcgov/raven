import type { KubeObject } from "./openshift-client.js";

const SENSITIVE_ENV_NAME = /pass|secret|token|key|credential|auth|private|cert|dsn|conn/i;
/** Field names whose string values are credentials, e.g. ConfigMap data.password or data.api_key. */
const SENSITIVE_FIELD = /pass|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credential|auth|dsn|conn(ection)?[-_.]?str/i;
/** Fields that only name or locate a credential (secretName, secretKeyRef, passwordFile, …). */
const REFERENCE_FIELD = /(name|ref|path|file|type|kind|mode|seconds)$/i;
/** `key` / `tls.key` hold key material, except where they name a key (secretKeyRef.key, volume items[].key). */
const KEY_FIELD = /^(key|.+\.key)$/i;
const KEY_NAME_PARENT = /keyref$|^items$/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g;
const DROPPED_ANNOTATIONS = ["kubectl.kubernetes.io/last-applied-configuration", "openshift.io/requester"];
export const REDACTED = "[REDACTED]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace PEM private-key blocks anywhere in text (PiScrubber does not recognise them). */
export function redactPrivateKeys(text: string): string {
  return text.replace(PRIVATE_KEY_BLOCK, REDACTED);
}

function isSensitiveField(key: string, parent: string | undefined): boolean {
  if (KEY_FIELD.test(key)) return !(parent && KEY_NAME_PARENT.test(parent));
  return SENSITIVE_FIELD.test(key) && !REFERENCE_FIELD.test(key);
}

/**
 * Deep-copy a Kubernetes object, removing noise (managedFields, last-applied
 * snapshots), credential-like field and environment values, and private keys.
 */
export function sanitizeObject<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown, parent?: string): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return redactPrivateKeys(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, parent));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "managedFields") continue;
    if (typeof child === "string" && isSensitiveField(key, parent)) {
      out[key] = REDACTED;
      continue;
    }
    if (key === "env" && Array.isArray(child)) {
      out[key] = child.map((entry) =>
        isRecord(entry) && typeof entry["name"] === "string" && "value" in entry && SENSITIVE_ENV_NAME.test(entry["name"])
          ? { ...entry, value: REDACTED }
          : walk(entry, key),
      );
      continue;
    }
    if (key === "annotations" && isRecord(child)) {
      out[key] = walk(Object.fromEntries(Object.entries(child).filter(([name]) => !DROPPED_ANNOTATIONS.includes(name))), key);
      continue;
    }
    out[key] = walk(child, key);
  }
  return out;
}

interface ContainerStatus {
  name?: string;
  image?: string;
  imageID?: string;
  ready?: boolean;
  restartCount?: number;
}

/** Compact pod view focused on what is needed to map an image to a workload. */
export function summarizePod(pod: KubeObject) {
  const metadata = (pod.metadata ?? {}) as KubeObject["metadata"] & Record<string, unknown>;
  const spec = isRecord(pod["spec"]) ? pod["spec"] : {};
  const status = isRecord(pod["status"]) ? pod["status"] : {};
  const statuses = [
    ...((status["initContainerStatuses"] as ContainerStatus[] | undefined) ?? []),
    ...((status["containerStatuses"] as ContainerStatus[] | undefined) ?? []),
  ];
  const specContainers = [
    ...((spec["initContainers"] as { name?: string; image?: string }[] | undefined) ?? []),
    ...((spec["containers"] as { name?: string; image?: string }[] | undefined) ?? []),
  ];
  return {
    name: metadata?.name,
    namespace: metadata?.namespace,
    phase: status["phase"],
    node: spec["nodeName"],
    startTime: status["startTime"],
    labels: metadata?.labels ?? {},
    owners: (metadata?.ownerReferences ?? []).map((o) => ({ kind: o.kind, name: o.name })),
    containers: specContainers.map((c) => {
      const s = statuses.find((st) => st.name === c.name);
      return {
        name: c.name,
        image: c.image,
        imageID: s?.imageID,
        ready: s?.ready,
        restartCount: s?.restartCount,
      };
    }),
  };
}

/** True when the pod runs an image whose reference or resolved digest contains `needle`. */
export function podUsesImage(pod: KubeObject, needle: string): boolean {
  return summarizePod(pod).containers.some(
    (c) => (c.image ?? "").includes(needle) || (c.imageID ?? "").includes(needle),
  );
}

/** Compact event view, newest first when sorted by `last`. */
export function summarizeEvent(event: KubeObject) {
  const involved = isRecord(event["involvedObject"]) ? event["involvedObject"] : {};
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const series = isRecord(event["series"]) ? event["series"] : {};
  const last = event["lastTimestamp"] ?? series["lastObservedTime"] ?? event["eventTime"] ?? metadata?.["creationTimestamp"];
  return {
    type: event["type"],
    reason: event["reason"],
    message: event["message"],
    object: `${String(involved["kind"] ?? "?")}/${String(involved["name"] ?? "?")}`,
    count: event["count"],
    last: last instanceof Date ? last.toISOString() : (last as string | undefined),
  };
}
