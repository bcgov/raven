import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("uses SonarCloud when SONARQUBE_URL is not configured", async () => {
  vi.stubEnv("SONARQUBE_URL", undefined);
  vi.stubEnv("SONARQUBE_TOKEN", "test-token");
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ paging: { pageIndex: 1, total: 0 }, components: [] })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { createSonarServer } = await import("../server.js");
  const server = createSonarServer();
  const client = new Client({ name: "sonar-cloud-test", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const missing = await client.callTool({ name: "sonar_list_projects", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await client.callTool({
      name: "sonar_list_projects",
      arguments: { organization: "my-org" },
    });
    expect(result.isError).not.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://sonarcloud.io/api/components/search");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("organization")).toBe("my-org");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
