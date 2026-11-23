/**
 * Guardrails applied before any request reaches the cluster. They narrow what
 * the model can ask for; the OpenShift identity's RBAC remains the real
 * enforcement boundary.
 */

/** API groups whose objects expose credentials, authorization or identity data. */
const DENIED_GROUPS = new Set([
  "rbac.authorization.k8s.io",
  "authorization.openshift.io",
  "authentication.k8s.io",
  "oauth.openshift.io",
  "user.openshift.io",
  "security.openshift.io",
]);

/** Kinds denied in every API group (core Secrets/ServiceAccounts and look-alike CRDs). */
const DENIED_KINDS = new Set(["secret", "serviceaccount"]);

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const API_VERSION = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?v[0-9]+((alpha|beta)[0-9]+)?$/;
const KIND = /^[A-Z][A-Za-z0-9]*$/;

export function isValidName(value: string): boolean {
  return value.length <= 253 && DNS_SUBDOMAIN.test(value);
}

export function isValidNamespace(value: string): boolean {
  return value.length <= 63 && DNS_LABEL.test(value);
}

export function isValidApiVersion(value: string): boolean {
  return value.length <= 253 && API_VERSION.test(value);
}

export function isValidKind(value: string): boolean {
  return value.length <= 63 && KIND.test(value);
}

/** Throw when a kind is outside the read surface this server will expose. */
export function assertAllowedKind(apiVersion: string, kind: string): void {
  const group = apiVersion.includes("/") ? apiVersion.slice(0, apiVersion.indexOf("/")) : "";
  if (DENIED_GROUPS.has(group) || DENIED_KINDS.has(kind.toLowerCase())) {
    throw new Error(
      `Access to ${kind} (${apiVersion}) is blocked by RAVEN: credential, RBAC and identity resources are never exposed.`,
    );
  }
}

/**
 * Parse OPENSHIFT_ALLOWED_NAMESPACES. Returns undefined when unset, meaning
 * the cluster identity's RBAC alone decides which namespaces are readable.
 */
export function allowedNamespaces(raw = process.env["OPENSHIFT_ALLOWED_NAMESPACES"]): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const list = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const invalid = list.filter((ns) => !isValidNamespace(ns));
  if (invalid.length) {
    throw new Error(`OPENSHIFT_ALLOWED_NAMESPACES contains invalid namespace(s): ${invalid.join(", ")}`);
  }
  return list;
}

/**
 * Validate a requested namespace against the allowlist. When an allowlist is
 * configured, a namespace is mandatory so cluster-wide reads cannot bypass it.
 */
export function resolveNamespace(requested: string | undefined, allowed = allowedNamespaces()): string | undefined {
  if (!allowed) return requested;
  if (!requested) {
    throw new Error(
      `A namespace is required because OPENSHIFT_ALLOWED_NAMESPACES is set. Allowed: ${allowed.join(", ")}`,
    );
  }
  if (!allowed.includes(requested)) {
    throw new Error(`Namespace '${requested}' is not in OPENSHIFT_ALLOWED_NAMESPACES.`);
  }
  return requested;
}
