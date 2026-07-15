import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactoryClient } from "../artifactory-client.js";
import { configuredArtifactoryCredentials, createArtifactoryServer } from "../server.js";

async function connectedClient(clientOverride: ArtifactoryClient) {
  const server = createArtifactoryServer(clientOverride);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "artifactory-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const openConnections: Array<Awaited<ReturnType<typeof connectedClient>>> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Artifactory MCP server", () => {
  it("uses dedicated Artifactory credentials and does not reuse Atlassian variables", () => {
    expect(configuredArtifactoryCredentials({
      ARTIFACTORY_EMAIL: "person@gov.bc.ca",
      ARTIFACTORY_PASSWORD: "idir-password",
      ATLASSIAN_EMAIL: "atlassian@gov.bc.ca",
      ATLASSIAN_PASSWORD: "atlassian-password",
    })).toEqual({ email: "person@gov.bc.ca", password: "idir-password" });
    expect(configuredArtifactoryCredentials({
      ATLASSIAN_EMAIL: "atlassian@gov.bc.ca",
      ATLASSIAN_PASSWORD: "atlassian-password",
    })).toBeNull();
  });

  it("uses an internal Artifactory URL placeholder in documentation and examples", async () => {
    const files = await Promise.all([
      readFile(new URL("../../../../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../../../../README.md", import.meta.url), "utf8"),
      readFile(new URL("../../README.md", import.meta.url), "utf8"),
    ]);

    for (const content of files) {
      const configuredUrl = /^ARTIFACTORY_URL=(.+)$/m.exec(content)?.[1];
      expect(configuredUrl).toMatch(/^<internal Artifactory HTTPS base URL/);
      expect(configuredUrl).not.toMatch(/^https:/);
    }
  });

  it("includes Artifactory credentials in the Windows DPAPI setup script", async () => {
    const script = await readFile(new URL("../../../../scripts/setup-credentials.ps1", import.meta.url), "utf8");

    for (const key of ["ARTIFACTORY_URL", "ARTIFACTORY_EMAIL", "ARTIFACTORY_PASSWORD"]) {
      expect(script).toContain(`Prompt-Value "${key}"`);
      expect(script).toContain(`$creds["${key}"]`);
    }
  });

  it("advertises the complete generic tool surface with read/write annotations", async () => {
    const connection = await connectedClient({} as ArtifactoryClient);
    openConnections.push(connection);
    const { tools } = await connection.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "artifactory_copy_item",
      "artifactory_delete_item",
      "artifactory_delete_item_properties",
      "artifactory_download_artifact",
      "artifactory_get_build_info",
      "artifactory_get_item_info",
      "artifactory_get_item_properties",
      "artifactory_get_item_stats",
      "artifactory_get_version",
      "artifactory_list_build_runs",
      "artifactory_list_builds",
      "artifactory_list_folder",
      "artifactory_list_repositories",
      "artifactory_move_item",
      "artifactory_ping",
      "artifactory_search_artifacts",
      "artifactory_search_items",
      "artifactory_set_item_properties",
      "artifactory_upload_artifact",
    ]);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint)).toHaveLength(12);
    expect(tools.filter((tool) => !tool.annotations?.readOnlyHint)).toHaveLength(7);
  });

  it("refuses live copy without exact destination confirmation", async () => {
    const copyItem = vi.fn();
    const connection = await connectedClient({ copyItem } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_copy_item",
      arguments: {
        sourceRepository: "source-local",
        sourcePath: "app.war",
        targetRepository: "target-local",
        targetPath: "app.war",
        execute: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(copyItem).not.toHaveBeenCalled();
  });

  it("rejects invalid repository keys at the MCP boundary", async () => {
    const getItemInfo = vi.fn();
    const connection = await connectedClient({ getItemInfo } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_get_item_info",
      arguments: { repository: "invalid/repository", itemPath: "app.war" },
    });

    expect(result.isError).toBe(true);
    expect(getItemInfo).not.toHaveBeenCalled();
  });

  it("rejects invalid transfer repository keys at the MCP boundary", async () => {
    const copyItem = vi.fn();
    const connection = await connectedClient({ copyItem } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_copy_item",
      arguments: {
        sourceRepository: "invalid/repository",
        sourcePath: "app.war",
        targetRepository: "target-local",
        targetPath: "app.war",
      },
    });

    expect(result.isError).toBe(true);
    expect(copyItem).not.toHaveBeenCalled();
  });

  it("rejects traversal item paths at the MCP boundary", async () => {
    const getItemInfo = vi.fn();
    const connection = await connectedClient({ getItemInfo } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_get_item_info",
      arguments: { repository: "libs-local", itemPath: "../secret.txt" },
    });

    expect(result.isError).toBe(true);
    expect(getItemInfo).not.toHaveBeenCalled();
  });

  it.each(["/app.war", "app.war/"])("rejects ambiguous item path %s at the MCP boundary", async (itemPath) => {
    const getItemInfo = vi.fn();
    const connection = await connectedClient({ getItemInfo } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_get_item_info",
      arguments: { repository: "libs-local", itemPath },
    });

    expect(result.isError).toBe(true);
    expect(getItemInfo).not.toHaveBeenCalled();
  });

  it("refuses deletion when the expected SHA-256 is stale", async () => {
    const deleteItem = vi.fn();
    const getItemInfo = vi.fn().mockResolvedValue({
      repo: "libs-local",
      path: "/app.war",
      checksums: { sha256: "a".repeat(64) },
    });
    const connection = await connectedClient({ getItemInfo, deleteItem } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_delete_item",
      arguments: {
        repository: "libs-local",
        itemPath: "app.war",
        expectedSha256: "b".repeat(64),
        confirmation: "libs-local/app.war",
      },
    });

    expect(result.isError).toBe(true);
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("downloads only beneath the protected root and verifies SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "raven-artifactory-download-"));
    tempDirectories.push(root);
    vi.stubEnv("RAVEN_ARTIFACTORY_DOWNLOAD_DIR", root);
    const data = Buffer.from("verified-artifact");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const clientOverride = {
      getItemInfo: vi.fn().mockResolvedValue({ checksums: { sha256 } }),
      downloadArtifact: vi.fn().mockResolvedValue({
        body: new Blob([Uint8Array.from(data).buffer]).stream(),
        contentLength: data.byteLength,
      }),
    } as unknown as ArtifactoryClient;
    const connection = await connectedClient(clientOverride);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_download_artifact",
      arguments: { repository: "libs-local", itemPath: "com/example/app.war" },
    });

    expect(result.isError).not.toBe(true);
    await expect(readFile(join(root, "libs-local", "com", "example", "app.war"), "utf8"))
      .resolves.toBe("verified-artifact");
    await expect(readdir(join(root, "libs-local", "com", "example"))).resolves.toEqual(["app.war"]);
  });

  it("removes a partial download when a chunked response exceeds the transfer limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "raven-artifactory-limit-"));
    tempDirectories.push(root);
    vi.stubEnv("RAVEN_ARTIFACTORY_DOWNLOAD_DIR", root);
    vi.stubEnv("RAVEN_ARTIFACTORY_MAX_TRANSFER_BYTES", "5");
    const data = Buffer.from("123456");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const connection = await connectedClient({
      getItemInfo: vi.fn().mockResolvedValue({ checksums: { sha256 } }),
      downloadArtifact: vi.fn().mockResolvedValue({
        body: new Blob([Uint8Array.from(data).buffer]).stream(),
      }),
    } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_download_artifact",
      arguments: { repository: "libs-local", itemPath: "app.war" },
    });

    expect(result.isError).toBe(true);
    await expect(readFile(join(root, "libs-local", "app.war"))).rejects.toThrow();
    await expect(readdir(join(root, "libs-local"))).resolves.toEqual([]);
  });

  it("preserves an existing destination when a streamed overwrite fails checksum verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "raven-artifactory-overwrite-failure-"));
    tempDirectories.push(root);
    vi.stubEnv("RAVEN_ARTIFACTORY_DOWNLOAD_DIR", root);
    const repositoryDirectory = join(root, "libs-local");
    await mkdir(repositoryDirectory, { mode: 0o700 });
    const destination = join(repositoryDirectory, "app.war");
    await writeFile(destination, "original-artifact", { mode: 0o600 });
    const replacement = Buffer.from("replacement-artifact");
    const connection = await connectedClient({
      getItemInfo: vi.fn().mockResolvedValue({ checksums: { sha256: "a".repeat(64) } }),
      downloadArtifact: vi.fn().mockResolvedValue({
        body: new Blob([Uint8Array.from(replacement).buffer]).stream(),
        contentLength: replacement.byteLength,
      }),
    } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_download_artifact",
      arguments: { repository: "libs-local", itemPath: "app.war", overwrite: true },
    });

    expect(result.isError).toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("original-artifact");
    await expect(readdir(repositoryDirectory)).resolves.toEqual(["app.war"]);
  });

  it("atomically replaces an existing destination after streamed checksum verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "raven-artifactory-overwrite-success-"));
    tempDirectories.push(root);
    vi.stubEnv("RAVEN_ARTIFACTORY_DOWNLOAD_DIR", root);
    const repositoryDirectory = join(root, "libs-local");
    await mkdir(repositoryDirectory, { mode: 0o700 });
    const destination = join(repositoryDirectory, "app.war");
    await writeFile(destination, "original-artifact", { mode: 0o600 });
    const replacement = Buffer.from("replacement-artifact");
    const sha256 = createHash("sha256").update(replacement).digest("hex");
    const connection = await connectedClient({
      getItemInfo: vi.fn().mockResolvedValue({ checksums: { sha256 } }),
      downloadArtifact: vi.fn().mockResolvedValue({
        body: new Blob([Uint8Array.from(replacement).buffer]).stream(),
        contentLength: replacement.byteLength,
      }),
    } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_download_artifact",
      arguments: { repository: "libs-local", itemPath: "app.war", overwrite: true },
    });

    expect(result.isError).not.toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("replacement-artifact");
    await expect(readdir(repositoryDirectory)).resolves.toEqual(["app.war"]);
  });

  it("refuses overwrite downloads on Windows before fetching artifact data", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const getItemInfo = vi.fn();
    const downloadArtifact = vi.fn();
    const connection = await connectedClient({ getItemInfo, downloadArtifact } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_download_artifact",
      arguments: { repository: "libs-local", itemPath: "app.war", overwrite: true },
    });

    expect(result.isError).toBe(true);
    expect(getItemInfo).not.toHaveBeenCalled();
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  it("refuses a symlinked download path before writing outside the protected root", async () => {
    const root = await mkdtemp(join(tmpdir(), "raven-artifactory-root-"));
    const outside = await mkdtemp(join(tmpdir(), "raven-artifactory-outside-"));
    tempDirectories.push(root, outside);
    await symlink(outside, join(root, "libs-local"), "dir");
    vi.stubEnv("RAVEN_ARTIFACTORY_DOWNLOAD_DIR", root);
    const data = Buffer.from("must-stay-contained");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const connection = await connectedClient({
      getItemInfo: vi.fn().mockResolvedValue({ checksums: { sha256 } }),
      downloadArtifact: vi.fn().mockResolvedValue({
        body: new Blob([Uint8Array.from(data).buffer]).stream(),
        contentLength: data.byteLength,
      }),
    } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_download_artifact",
      arguments: { repository: "libs-local", itemPath: "app.war" },
    });

    expect(result.isError).toBe(true);
    await expect(readFile(join(outside, "app.war"))).rejects.toThrow();
  });

  it("uploads a mode-restricted file from the protected upload root with computed checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "raven-artifactory-upload-"));
    tempDirectories.push(root);
    const source = join(root, "app.war");
    await writeFile(source, "upload-artifact", { mode: 0o600 });
    await chmod(source, 0o600);
    vi.stubEnv("RAVEN_ARTIFACTORY_UPLOAD_DIR", root);
    const uploadArtifact = vi.fn().mockResolvedValue({ repo: "libs-local", path: "/app.war" });
    const connection = await connectedClient({ uploadArtifact } as unknown as ArtifactoryClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "artifactory_upload_artifact",
      arguments: {
        sourceFile: "app.war",
        repository: "libs-local",
        itemPath: "app.war",
        overwrite: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    expect(await uploadArtifact.mock.calls[0][2].text()).toBe("upload-artifact");
    expect(uploadArtifact.mock.calls[0][3]).toEqual({
      sha1: createHash("sha1").update("upload-artifact").digest("hex"),
      sha256: createHash("sha256").update("upload-artifact").digest("hex"),
    });
  });
});
