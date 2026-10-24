const DEFAULT_SYSDIG_MCP_URL = "https://secure.sysdig.com/mcp/secure";

export function resolveSysdigMcpUrl(
  env: Record<string, string | undefined> = process.env,
): URL {
  const raw = env["SYSDIG_SECURE_MCP_URL"] ?? DEFAULT_SYSDIG_MCP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SYSDIG_SECURE_MCP_URL must be a valid HTTPS URL.");
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".sysdig.com") && url.hostname !== "sysdig.com" ||
    url.username ||
    url.password ||
    url.pathname.replace(/\/+$/, "") !== "/mcp/secure" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SYSDIG_SECURE_MCP_URL must be a regional Sysdig HTTPS /mcp/secure endpoint.",
    );
  }

  url.pathname = "/mcp/secure";
  return url;
}
