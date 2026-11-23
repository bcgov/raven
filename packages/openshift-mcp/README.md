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
- `managedFields`, last-applied annotations and environment values whose names look like credentials are removed from output.
- All output passes through `PiScrubber` and is truncated at 100,000 characters.

MCP-side filtering is defence in depth, not authorization. Use an identity bound to the built-in `view` role in only the projects you need, for example:

```sh
oc adm policy add-role-to-user view <user> -n <project>
```

`view` excludes Secrets and cannot modify anything.
