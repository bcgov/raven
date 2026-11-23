import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiException } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenShiftServer } from "../server.js";
import { loadKubeConfig, type KubeObject, type OpenShiftReader } from "../openshift-client.js";

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
  let reader: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; podLog: ReturnType<typeof vi.fn> };
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    reader = { list: vi.fn(), get: vi.fn(), podLog: vi.fn() };
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
});
