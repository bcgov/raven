import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiException, KubeConfig } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenShiftServer } from "../server.js";
import { KubeOpenShiftReader, loadKubeConfig, type KubeObject, type OpenShiftReader } from "../openshift-client.js";

describe("loadKubeConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "raven-openshift-"));
  const kubeconfig = join(dir, "config");
  writeFileSync(
    kubeconfig,
    [
      "apiVersion: v1",
      "kind: Config",
      "clusters:",
      "- name: c",
      "  cluster: { server: 'https://api.example:6443', insecure-skip-tls-verify: true }",
      "users:",
      "- name: u",
      "  user: { token: t }",
      "contexts:",
      "- name: c",
      "  context: { cluster: c, user: u }",
      "current-context: c",
      "",
    ].join("\n"),
  );

  afterEach(() => vi.unstubAllEnvs());

  it("refuses kubeconfigs that skip TLS verification unless explicitly allowed", () => {
    vi.stubEnv("KUBECONFIG", kubeconfig);
    expect(() => loadKubeConfig()).toThrow(/insecure-skip-tls-verify/);
    vi.stubEnv("OPENSHIFT_ALLOW_INSECURE_TLS", "true");
    expect(loadKubeConfig().getCurrentCluster()?.server).toBe("https://api.example:6443");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("KubeOpenShiftReader", () => {
  it("keeps the continue token of OpenShift-native lists and reports resource scope", async () => {
    const requests: string[] = [];
    const routes = {
      apiVersion: "route.openshift.io/v1",
      kind: "RouteList",
      metadata: { continue: "next-page", resourceVersion: "1" },
      items: [{ apiVersion: "route.openshift.io/v1", kind: "Route", metadata: { name: "web", namespace: "app-dev" } }],
    };
    const responses: Record<string, unknown> = {
      "/api/v1": { kind: "APIResourceList", groupVersion: "v1", resources: [{ name: "nodes", kind: "Node", namespaced: false, verbs: ["get"] }] },
      "/apis/route.openshift.io/v1": {
        kind: "APIResourceList",
        groupVersion: "route.openshift.io/v1",
        resources: [{ name: "routes", kind: "Route", namespaced: true, verbs: ["list"] }],
      },
      "/apis/route.openshift.io/v1/namespaces/app-dev/routes": routes,
    };
    const http = createServer((req, res) => {
      requests.push(req.url ?? "");
      const body = responses[(req.url ?? "").split("?")[0]!];
      res.writeHead(body ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { kind: "Status", message: "Unauthorized" }));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const kc = new KubeConfig();
      kc.loadFromOptions({
        // Plain HTTP test server; production TLS policy is enforced by loadKubeConfig, which this bypasses.
        clusters: [{ name: "c", server: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, skipTLSVerify: true }],
        users: [{ name: "u", token: "t" }],
        contexts: [{ name: "c", cluster: "c", user: "u" }],
        currentContext: "c",
      });
      const reader = new KubeOpenShiftReader(kc);

      const page = await reader.list("route.openshift.io/v1", "Route", { namespace: "app-dev", limit: 1 });
      expect(page.continueToken).toBe("next-page");
      expect(page.items.map((r) => r.metadata?.name)).toEqual(["web"]);
      expect(requests).toContain("/apis/route.openshift.io/v1/namespaces/app-dev/routes?limit=1");
      await expect(reader.isNamespaced("v1", "Node")).resolves.toBe(false);
      await expect(reader.isNamespaced("route.openshift.io/v1", "Route")).resolves.toBe(true);
      await expect(reader.get("route.openshift.io/v1", "Route", "missing", "app-dev")).rejects.toMatchObject({ code: 401 });
    } finally {
      http.close();
    }
  });
});

function pod(name: string, namespace: string, image: string, imageID: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: { app: name },
      ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: `${name}-rs`, uid: "u", controller: true }],
    },
    spec: { nodeName: "worker-1", containers: [{ name: "app", image }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", image, imageID, ready: true, restartCount: 2 }] },
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text: string }[];
  if (first?.type !== "text") throw new Error("Expected text content");
  return first.text;
}

describe("OpenShift MCP server", () => {
  let reader: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    podLog: ReturnType<typeof vi.fn>;
    isNamespaced: ReturnType<typeof vi.fn>;
  };
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    reader = { list: vi.fn(), get: vi.fn(), podLog: vi.fn(), isNamespaced: vi.fn().mockResolvedValue(true) };
    const server = createOpenShiftServer({ reader: reader as unknown as OpenShiftReader });
    client = new Client({ name: "openshift-test", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await Promise.all([client.close(), server.close()]);
    };
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
  });

  it("advertises only read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual([]);
  });

  it.each([
    ["v1", "Secret"],
    ["v1", "ServiceAccount"],
    ["rbac.authorization.k8s.io/v1", "RoleBinding"],
    ["oauth.openshift.io/v1", "OAuthAccessToken"],
    ["user.openshift.io/v1", "Identity"],
  ])("blocks %s %s without contacting the cluster", async (apiVersion, kind) => {
    const get = await client.callTool({
      name: "openshift_get_resource",
      arguments: { apiVersion, kind, name: "x", namespace: "app-dev" },
    });
    const list = await client.callTool({ name: "openshift_list_resources", arguments: { apiVersion, kind, namespace: "app-dev" } });
    expect(get.isError).toBe(true);
    expect(list.isError).toBe(true);
    expect(text(get)).toMatch(/blocked by RAVEN/);
    expect(reader.get).not.toHaveBeenCalled();
    expect(reader.list).not.toHaveBeenCalled();
  });

  it("enforces OPENSHIFT_ALLOWED_NAMESPACES on reads and project listings", async () => {
    vi.stubEnv("OPENSHIFT_ALLOWED_NAMESPACES", "app-dev, app-test");
    const outside = await client.callTool({ name: "openshift_list_pods", arguments: { namespace: "kube-system" } });
    const clusterWide = await client.callTool({
      name: "openshift_list_resources",
      arguments: { apiVersion: "v1", kind: "Node" },
    });
    expect(outside.isError).toBe(true);
    expect(clusterWide.isError).toBe(true);
    expect(reader.list).not.toHaveBeenCalled();

    reader.isNamespaced.mockResolvedValue(false);
    const nodeList = await client.callTool({
      name: "openshift_list_resources",
      arguments: { apiVersion: "v1", kind: "Node", namespace: "app-dev" },
    });
    const nodeGet = await client.callTool({
      name: "openshift_get_resource",
      arguments: { apiVersion: "v1", kind: "Node", name: "worker-1", namespace: "app-dev" },
    });
    expect(nodeList.isError).toBe(true);
    expect(text(nodeGet)).toMatch(/cluster-scoped/);
    expect(reader.isNamespaced).toHaveBeenCalledWith("v1", "Node");
    expect(reader.list).not.toHaveBeenCalled();
    expect(reader.get).not.toHaveBeenCalled();

    reader.list.mockResolvedValueOnce({
      items: [{ metadata: { name: "app-dev" } }, { metadata: { name: "other" } }],
    });
    const projects = JSON.parse(text(await client.callTool({ name: "openshift_list_projects", arguments: {} })));
    expect(projects.projects.map((p: { name: string }) => p.name)).toEqual(["app-dev"]);
  });

  it("maps an image digest to pods across every allowed project", async () => {
    vi.stubEnv("OPENSHIFT_ALLOWED_NAMESPACES", "app-dev,app-test");
    const digest = "sha256:0123456789abcdef";
    reader.list
      .mockResolvedValueOnce({ items: [pod("api", "app-dev", "registry/api:1.2", `registry/api@${digest}`), pod("db", "app-dev", "registry/db:9", "registry/db@sha256:ffff0000")] })
      .mockResolvedValueOnce({ items: [pod("api", "app-test", "registry/api:1.2", `registry/api@${digest}`)] });

    const result = JSON.parse(text(await client.callTool({ name: "openshift_find_pods_by_image", arguments: { image: digest } })));

    expect(reader.list.mock.calls.map((c) => c[2].namespace)).toEqual(["app-dev", "app-test"]);
    expect(result.scannedPods).toBe(3);
    expect(result.matches).toEqual([
      expect.objectContaining({ name: "api", namespace: "app-dev", owners: [{ kind: "ReplicaSet", name: "api-rs" }] }),
      expect.objectContaining({ name: "api", namespace: "app-test" }),
    ]);
    expect(result.matches[0].containers[0]).toMatchObject({ imageID: `registry/api@${digest}`, restartCount: 2 });
  });

  it("removes managedFields, credential-like env values and PI from objects", async () => {
    const object = pod("api", "app-dev", "registry/api:1", "id");
    (object.metadata as Record<string, unknown>)["managedFields"] = [{ manager: "kubectl" }];
    (object["spec"] as { containers: Record<string, unknown>[] }).containers[0]!["env"] = [
      { name: "DB_PASSWORD", value: "hunter2-very-secret" },
      { name: "LOG_LEVEL", value: "debug" },
      { name: "OWNER", value: "jane.doe@gov.bc.ca" },
    ];
    reader.get.mockResolvedValueOnce(object);

    const output = text(await client.callTool({ name: "openshift_get_pod", arguments: { namespace: "app-dev", name: "api" } }));

    expect(output).not.toContain("managedFields");
    expect(output).not.toContain("hunter2-very-secret");
    expect(output).not.toContain("jane.doe@gov.bc.ca");
    expect(output).toContain("debug");
  });

  it("redacts credential fields and private keys outside env vars", async () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretkeymaterial\n-----END RSA PRIVATE KEY-----";
    reader.get
      .mockResolvedValueOnce({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "settings", namespace: "app-dev", annotations: { "example.com/api-token": "tok-abc123" } },
        data: { password: "hunter2-in-configmap", "tls.key": "not-pem-but-key", LOG_LEVEL: "debug" },
      })
      .mockResolvedValueOnce({
        apiVersion: "route.openshift.io/v1",
        kind: "Route",
        metadata: { name: "web", namespace: "app-dev" },
        spec: {
          host: "web.apps.example",
          tls: { termination: "edge", key: pem, certificate: "-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----" },
        },
      })
      .mockResolvedValueOnce({
        ...pod("api", "app-dev", "registry/api:1", "id"),
        spec: {
          containers: [{ name: "app", image: "registry/api:1", env: [{ name: "DB", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }] }],
          volumes: [{ name: "tls", secret: { secretName: "web-tls", items: [{ key: "tls.key", path: "tls.key" }] } }],
        },
      });
    reader.podLog.mockResolvedValueOnce(`starting\n${pem}\ndone`);
    const get = async (apiVersion: string, kind: string) =>
      JSON.parse(text(await client.callTool({ name: "openshift_get_resource", arguments: { apiVersion, kind, name: "x", namespace: "app-dev" } })));

    const configMap = await get("v1", "ConfigMap");
    expect(configMap.data).toEqual({ password: "[REDACTED]", "tls.key": "[REDACTED]", LOG_LEVEL: "debug" });
    expect(configMap.metadata.annotations["example.com/api-token"]).toBe("[REDACTED]");

    const route = await get("route.openshift.io/v1", "Route");
    expect(route.spec.tls.key).toBe("[REDACTED]");
    expect(route.spec.tls.certificate).toContain("BEGIN CERTIFICATE");

    const podObject = await get("v1", "Pod");
    expect(podObject.spec.containers[0].env[0].valueFrom.secretKeyRef).toEqual({ name: "db", key: "password" });
    expect(podObject.spec.volumes[0].secret).toEqual({ secretName: "web-tls", items: [{ key: "tls.key", path: "tls.key" }] });

    const logs = text(await client.callTool({ name: "openshift_get_pod_logs", arguments: { namespace: "app-dev", name: "api" } }));
    expect(logs).not.toContain("secretkeymaterial");
    expect(logs).toContain("done");
  });

  it("scrubs PI in user-controlled fields that share identifier names", async () => {
    reader.get.mockResolvedValueOnce({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "owner-6559871234", namespace: "app-dev", annotations: { image: "jane.doe@gov.bc.ca" } },
      data: { name: "jane.doe@gov.bc.ca" },
    });

    const output = text(
      await client.callTool({ name: "openshift_get_resource", arguments: { apiVersion: "v1", kind: "ConfigMap", name: "x", namespace: "app-dev" } }),
    );

    expect(output).not.toContain("jane.doe@gov.bc.ca");
    expect(JSON.parse(output).metadata.name).toBe("owner-6559871234");
  });

  it("redacts Secrets and credential parameters embedded in Templates", async () => {
    const dockerConfig = Buffer.from('{"auths":{"registry.example":{"auth":"dXNlcjpwYXNz"}}}').toString("base64");
    reader.get.mockResolvedValueOnce({
      apiVersion: "template.openshift.io/v1",
      kind: "Template",
      metadata: { name: "app", namespace: "app-dev" },
      parameters: [
        { name: "DATABASE_PASSWORD", value: "tmpl-hunter2" },
        { name: "APP_NAME", value: "api" },
      ],
      objects: [
        { apiVersion: "v1", kind: "Secret", metadata: { name: "pull" }, type: "kubernetes.io/dockerconfigjson", data: { ".dockerconfigjson": dockerConfig } },
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg" }, data: { LOG_LEVEL: "debug" } },
      ],
    });

    const output = text(
      await client.callTool({
        name: "openshift_get_resource",
        arguments: { apiVersion: "template.openshift.io/v1", kind: "Template", name: "app", namespace: "app-dev" },
      }),
    );
    const template = JSON.parse(output);

    expect(output).not.toContain(dockerConfig);
    expect(output).not.toContain("tmpl-hunter2");
    expect(template.objects[0]).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "pull" },
      type: "kubernetes.io/dockerconfigjson",
      content: "[REDACTED]",
    });
    expect(template.objects[1].data).toEqual({ LOG_LEVEL: "debug" });
    expect(template.parameters[1]).toEqual({ name: "APP_NAME", value: "api" });
  });

  it("matches ephemeral containers and redacts credential labels in pod summaries", async () => {
    const debug = pod("api", "app-dev", "registry/api:1", "registry/api@sha256:aaaa");
    (debug.metadata as Record<string, unknown>)["labels"] = { app: "api", "api-token": "opaque-abc" };
    (debug["spec"] as Record<string, unknown>)["ephemeralContainers"] = [{ name: "debugger", image: "registry/debug:1" }];
    (debug["status"] as Record<string, unknown>)["ephemeralContainerStatuses"] = [
      { name: "debugger", image: "registry/debug:1", imageID: "registry/debug@sha256:bbbb" },
    ];
    reader.list.mockResolvedValue({ items: [debug] });

    const found = JSON.parse(
      text(await client.callTool({ name: "openshift_find_pods_by_image", arguments: { image: "sha256:bbbb", namespace: "app-dev" } })),
    );
    const listed = text(await client.callTool({ name: "openshift_list_pods", arguments: { namespace: "app-dev" } }));

    expect(found.matches).toHaveLength(1);
    expect(found.matches[0].containers[1]).toMatchObject({ name: "debugger", imageID: "registry/debug@sha256:bbbb" });
    expect(found.matches[0].labels).toEqual({ app: "api", "api-token": "[REDACTED]" });
    expect(listed).not.toContain("opaque-abc");
  });

  it.each(["api:latest", "api@sha256:0123456789abcdef"])("accepts image resource name %s", async (name) => {
    reader.get.mockResolvedValueOnce({ apiVersion: "image.openshift.io/v1", kind: "ImageStreamTag", metadata: { name } });
    const result = await client.callTool({
      name: "openshift_get_resource",
      arguments: { apiVersion: "image.openshift.io/v1", kind: "ImageStreamTag", name, namespace: "app-dev" },
    });
    expect(result.isError).toBeFalsy();
    expect(reader.get).toHaveBeenCalledWith("image.openshift.io/v1", "ImageStreamTag", name, "app-dev");
  });

  it.each(["../secrets", "a/b", "a%2Fb", "a b", "..", "-x"])("rejects unsafe resource name %s", async (name) => {
    const result = await client.callTool({
      name: "openshift_get_resource",
      arguments: { apiVersion: "v1", kind: "ConfigMap", name, namespace: "app-dev" },
    });
    expect(result.isError).toBe(true);
    expect(reader.get).not.toHaveBeenCalled();
  });

  it("shrinks oversized resource pages instead of returning truncated JSON", async () => {
    const bulky = (i: number) => ({ metadata: { name: `obj-${i}` }, data: "setting: value\n".repeat(2_000) });
    reader.list.mockImplementation(async (_v: string, _k: string, opts: { limit: number }) => ({
      items: Array.from({ length: opts.limit }, (_, i) => bulky(i)),
      continueToken: `after-${opts.limit}`,
    }));

    const result = JSON.parse(
      text(await client.callTool({ name: "openshift_list_resources", arguments: { apiVersion: "v1", kind: "ConfigMap", namespace: "app-dev", limit: 10 } })),
    );

    expect(reader.list.mock.calls.map((c) => c[2].limit)).toEqual([10, 5, 2]);
    expect(result.items).toHaveLength(2);
    expect(result.continue).toBe("after-2");
  });

  it("returns valid JSON that keeps identifiers, field names and dates intact", async () => {
    const created = new Date("2026-11-17T21:59:45Z");
    const object = pod("app-5-status-6559871234-srj72", "app-dev", "registry/status:1", "id");
    (object.metadata as Record<string, unknown>)["creationTimestamp"] = created;
    (object.metadata as Record<string, unknown>)["labels"] = { "pod-template-hash": "6559871234" };
    (object.metadata as Record<string, unknown>)["annotations"] = { contact: "call 250-555-0199" };
    (object["spec"] as Record<string, unknown>)["automountServiceAccountToken"] = false;
    reader.get.mockResolvedValueOnce(object);

    const output = text(await client.callTool({ name: "openshift_get_pod", arguments: { namespace: "app-dev", name: "api" } }));
    const parsed = JSON.parse(output);

    expect(parsed.metadata.name).toBe("app-5-status-6559871234-srj72");
    expect(parsed.metadata.labels["pod-template-hash"]).toBe("6559871234");
    expect(parsed.metadata.creationTimestamp).toBe(created.toISOString());
    expect(parsed.spec.automountServiceAccountToken).toBe(false);
    expect(output).not.toContain("250-555-0199");
  });

  it("caps log requests and scrubs log output", async () => {
    reader.podLog.mockResolvedValueOnce("ERROR contact admin@example.com\n");
    const output = text(
      await client.callTool({ name: "openshift_get_pod_logs", arguments: { namespace: "app-dev", name: "api", previous: true } }),
    );
    expect(reader.podLog).toHaveBeenCalledWith("app-dev", "api", expect.objectContaining({ tailLines: 200, previous: true, limitBytes: 262144 }));
    expect(output).not.toContain("admin@example.com");

    const tooMany = await client.callTool({ name: "openshift_get_pod_logs", arguments: { namespace: "app-dev", name: "api", tailLines: 5000 } });
    expect(tooMany.isError).toBe(true);
  });

  it("explains RBAC denials from the API server", async () => {
    reader.list.mockRejectedValueOnce(
      new ApiException(403, "Forbidden", JSON.stringify({ message: 'pods is forbidden: cannot list resource "pods"' }), {}),
    );
    const result = await client.callTool({ name: "openshift_list_pods", arguments: { namespace: "app-dev" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/403.*cannot list resource.*lacks RBAC permission/s);
  });

  it("returns a size error instead of truncated JSON for oversized objects", async () => {
    reader.get.mockResolvedValueOnce({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "big" }, data: { blob: "setting: value\n".repeat(8_000) } });
    const result = await client.callTool({
      name: "openshift_get_resource",
      arguments: { apiVersion: "v1", kind: "ConfigMap", name: "big", namespace: "app-dev" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/over the 100000-character limit/);
  });

  it("scans at most 5000 pods across all allowed projects", async () => {
    const namespaces = Array.from({ length: 20 }, (_, i) => `app-${i}`);
    vi.stubEnv("OPENSHIFT_ALLOWED_NAMESPACES", namespaces.join(","));
    reader.list.mockImplementation(async (_v: string, _k: string, opts: { namespace: string; limit: number }) => ({
      items: Array.from({ length: Math.min(400, opts.limit) }, (_, i) => pod(`p${i}`, opts.namespace, "registry/other:1", "id")),
      continueToken: opts.limit < 400 ? "more" : undefined,
    }));

    const result = JSON.parse(text(await client.callTool({ name: "openshift_find_pods_by_image", arguments: { image: "registry/api" } })));

    expect(result.scannedPods).toBe(5_000);
    expect(result.truncated).toBe(true);
    expect(result.incompleteNamespaces).toEqual(namespaces.slice(12));
    expect(reader.list).toHaveBeenCalledTimes(13);
    expect(reader.list.mock.calls.at(-1)![2].limit).toBe(200);
  });

  it("reads every event page before returning the newest events", async () => {
    const event = (name: string, last: string, type = "Normal") => ({
      apiVersion: "v1",
      kind: "Event",
      metadata: { name },
      type,
      reason: "Test",
      involvedObject: { kind: "Pod", name: "api" },
      lastTimestamp: last,
    });
    reader.list
      .mockResolvedValueOnce({ items: [event("a", "2026-11-01T00:00:00Z"), event("b", "2026-11-02T00:00:00Z")], continueToken: "p2" })
      .mockResolvedValueOnce({ items: [event("c", "2026-11-20T00:00:00Z", "Warning")] });

    const result = JSON.parse(
      text(await client.callTool({ name: "openshift_list_events", arguments: { namespace: "app-dev", limit: 2 } })),
    );

    expect(reader.list.mock.calls.map((c) => c[2].continueToken)).toEqual([undefined, "p2"]);
    expect(result.scannedEvents).toBe(3);
    expect(result.events.map((e: { last: string }) => e.last)).toEqual(["2026-11-20T00:00:00Z", "2026-11-02T00:00:00Z"]);
  });
});

describe("OpenShift MCP server re-authentication", () => {
  it("reloads the kubeconfig-backed reader after a 401", async () => {
    const expired = { list: vi.fn().mockRejectedValue(new ApiException(401, "Unauthorized", "{}", {})) };
    const fresh = { list: vi.fn().mockResolvedValue({ items: [pod("api", "app-dev", "registry/api:1", "id")] }) };
    const readerFactory = vi
      .fn()
      .mockReturnValueOnce(expired as unknown as OpenShiftReader)
      .mockReturnValueOnce(fresh as unknown as OpenShiftReader);
    const server = createOpenShiftServer({ readerFactory });
    const client = new Client({ name: "openshift-test", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const first = await client.callTool({ name: "openshift_list_pods", arguments: { namespace: "app-dev" } });
      expect(text(first)).toMatch(/401.*oc login/s);
      const second = await client.callTool({ name: "openshift_list_pods", arguments: { namespace: "app-dev" } });
      expect(second.isError).toBeFalsy();
      expect(readerFactory).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
