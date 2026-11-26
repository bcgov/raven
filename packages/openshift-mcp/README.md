# @nrs/openshift-mcp

Read-only MCP server for OpenShift. It lets an assistant inspect projects, pods, logs, events and workload objects, and map a Sysdig image digest to the pods and Deployments running it.

## Authentication

The server reuses the kubeconfig written by `oc login` (`~/.kube/config` or `KUBECONFIG`). No token is stored in `~/.raven/.env`.

| Variable | Purpose |
|----------|---------|
| `KUBECONFIG` | kubeconfig path(s); default `~/.kube/config` |
| `OPENSHIFT_CONTEXT` | kubeconfig context to use instead of the current one |
| `OPENSHIFT_ALLOWED_NAMESPACES` | Recommended. Comma-separated projects the tools may read; any other namespace, and cluster-scoped kinds, are refused |
| `OPENSHIFT_ALLOW_INSECURE_TLS` | `true` accepts a kubeconfig with `insecure-skip-tls-verify` (refused by default) |

## Tools

All tools are annotated `readOnlyHint: true` and issue only HTTP GET requests.

| Tool | Purpose |
|------|---------|
| `openshift_list_projects` | Projects visible to the identity (filtered to the allowlist) |
| `openshift_list_pods` | Pods with phase, readiness, restarts, owners, images and resolved digests |
| `openshift_get_pod` | One pod's sanitized spec and status |
| `openshift_find_pods_by_image` | Pods whose image or digest matches a value (for example a Sysdig digest) |
| `openshift_list_events` | Recent events, newest first, filterable by object or Warning type |
| `openshift_get_pod_logs` | Tail of a container's logs (max 2,000 lines / 256 KiB), PI-scrubbed |
| `openshift_list_resources` | Objects of any permitted kind, with label/field selectors |
| `openshift_get_resource` | One object of any permitted kind |

## Safety controls

- No create, update, patch, delete, exec, port-forward or scale tools exist.
- Secrets, ServiceAccounts and the RBAC, OAuth, user, authentication and security-context-constraint API groups are always refused before any cluster call.
- With `OPENSHIFT_ALLOWED_NAMESPACES` set, cluster-scoped kinds (Node, Project, …) are refused by `openshift_list_resources` and `openshift_get_resource`, even when an allowed namespace is supplied.
- `managedFields`, last-applied annotations, PEM private keys, and values of credential-like fields (environment variables, Template parameters, labels, ConfigMap `data.password`, Route `spec.tls.key`, annotations, …) are removed from output. Secrets embedded in other objects (for example a Template's `objects`) keep only their name and type.
- All output passes through `PiScrubber`. Only cluster-generated identifiers (object names, UIDs, images, digests) are exempt; user-controlled fields such as ConfigMap data and annotations are always scrubbed.
- Structured results over 100,000 characters return an error instead of partial JSON; logs are truncated at that size.
- `openshift_find_pods_by_image` matches init, regular and ephemeral (debug) containers. It scans at most 5,000 pods in total and lists the namespaces it did not finish. `openshift_list_events` scans up to 5,000 events before choosing the newest.
- After a 401, the next call reloads the kubeconfig, so a fresh `oc login` takes effect without restarting the server.

MCP-side filtering is defence in depth, not authorization. Use an identity bound to the built-in `view` role in only the projects you need, for example:

```sh
oc adm policy add-role-to-user view <user> -n <project>
```

`view` excludes Secrets and cannot modify anything.
