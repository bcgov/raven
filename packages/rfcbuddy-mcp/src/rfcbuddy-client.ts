import type { RfcSearchResponse } from "./types.js";

/**
 * REST client for RFC Buddy target system API.
 * Uses configurable base URL and Personal Access Token (PAT) bearer authentication.
 */
export class RfcBuddyClient {
  private baseUrl: string;
  private token: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(baseUrl: string, token: string, fetchFn?: typeof globalThis.fetch) {
    let url = baseUrl;
    while (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    if (!url.endsWith("/api/v1")) {
      url = `${url}/api/v1`;
    }
    this.baseUrl = url;
    this.token = token;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /**
   * Performs an RFC search on the target system using inclusion/exclusion keywords.
   */
  async searchRfcs(
    includeKeywords: string[],
    ignoreKeywords?: string[],
  ): Promise<RfcSearchResponse> {
    const url = `${this.baseUrl}/rfcs/search`;

    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        includeKeywords,
        ignoreKeywords: ignoreKeywords ?? [],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `RFC Buddy API unexpected response: ${resp.status} ${resp.statusText} on POST /rfcs/search: ${body.slice(0, 500)}`,
      );
    }

    return (await resp.json()) as RfcSearchResponse;
  }
}
