import type { AuthenticatedFetch } from "@nrs/auth";
import type {
  AssetObject,
  AssetAttribute,
  AssetSchema,
  AssetObjectType,
  AssetHistoryEntry,
  AqlSearchResponse,
} from "./types.js";

const DEFAULT_BASE_URL =
  process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/jira`
    : "https://apps.example.gov.bc.ca/int/jira";

/**
 * REST client for Jira Assets (Insight) Data Center.
 * Uses /rest/insight/1.0/ for all asset operations.
 */
export class AssetsClient {
  readonly baseUrl: string;
  private insightUrl: string;
  private fetch: AuthenticatedFetch;

  constructor(fetch: AuthenticatedFetch, baseUrl?: string) {
    this.fetch = fetch;
    this.baseUrl =
      baseUrl ?? process.env["JIRA_URL"] ?? DEFAULT_BASE_URL;
    this.insightUrl = `${this.baseUrl}/rest/insight/1.0`;
  }

  // ---------------------------------------------------------------------------
  // AQL Search
  // ---------------------------------------------------------------------------

  /**
   * Execute an AQL (Asset Query Language) query.
   */
  async searchAql(
    query: string,
    options?: {
      schemaId?: number;
      page?: number;
      resultsPerPage?: number;
      includeAttributes?: boolean;
    }
  ): Promise<AqlSearchResponse> {
    const params = new URLSearchParams({
      iql: query,
      page: String(options?.page ?? 1),
      resultPerPage: String(options?.resultsPerPage ?? 25),
      includeAttributes: String(options?.includeAttributes ?? true),
    });
    if (options?.schemaId) {
      params.set("objectSchemaId", String(options.schemaId));
    }

    const resp = await this.fetch(
      `${this.insightUrl}/iql/objects?${params.toString()}`
    );
    if (!resp.ok) {
      throw new Error(
        `AQL search failed (${resp.status}): ${await resp.text()}`
      );
    }
    const data = (await resp.json()) as AqlSearchResponse;

    // Enrich: the IQL response includes objectTypeAttributes at the
    // response level with {id, name, type} for each attribute definition,
    // but individual object attributes only have objectTypeAttributeId
    // (objectTypeAttribute is not populated). Map names onto each attribute.
    if (data.objectTypeAttributes && data.objectTypeAttributes.length > 0) {
      const attrMap = new Map(
        data.objectTypeAttributes.map((a) => [a.id, a])
      );
      for (const obj of data.objectEntries) {
        for (const attr of obj.attributes) {
          if (!attr.objectTypeAttribute) {
            const def = attrMap.get(attr.objectTypeAttributeId);
            if (def) {
              attr.objectTypeAttribute = {
                id: def.id,
                name: def.name,
                type: def.type,
              };
            }
          }
          // Strip deeply nested attributes from referenced objects to
          // prevent circular references and stack overflow during
          // JSON serialization. We only need id/label/objectKey for display.
          for (const val of attr.objectAttributeValues) {
            if (val.referencedObject) {
              const ref = val.referencedObject as Record<string, unknown>;
              delete ref["attributes"];
              delete ref["avatar"];
              delete ref["_links"];
            }
          }
        }
      }
    }

    return data;
  }

  // ---------------------------------------------------------------------------
  // Object CRUD
  // ---------------------------------------------------------------------------

  /**
   * Get a single object by ID with all attributes.
   */
  async getObject(objectId: number): Promise<AssetObject> {
    const resp = await this.fetch(
      `${this.insightUrl}/object/${objectId}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get object ${objectId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as AssetObject;
  }

  /**
   * Get all attributes for an object.
   */
  async getObjectAttributes(objectId: number): Promise<AssetAttribute[]> {
    const resp = await this.fetch(
      `${this.insightUrl}/object/${objectId}/attributes`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get attributes for object ${objectId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as AssetAttribute[];
  }

  /**
   * Get change history for an object.
   */
  async getObjectHistory(objectId: number): Promise<AssetHistoryEntry[]> {
    const resp = await this.fetch(
      `${this.insightUrl}/object/${objectId}/history`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get history for object ${objectId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as AssetHistoryEntry[];
  }

  /**
   * Get Jira tickets connected to an asset object.
   */
  async getObjectConnectedTickets(
    objectId: number
  ): Promise<{ tickets: Array<{ key: string; title: string; status: string; type: string }> }> {
    const resp = await this.fetch(
      `${this.insightUrl}/objectconnectedtickets/${objectId}/tickets`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get connected tickets for object ${objectId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as {
      tickets: Array<{ key: string; title: string; status: string; type: string }>;
    };
  }

  // ---------------------------------------------------------------------------
  // Schema & Object Types
  // ---------------------------------------------------------------------------

  /**
   * List all available schemas.
   */
  async listSchemas(): Promise<AssetSchema[]> {
    const resp = await this.fetch(
      `${this.insightUrl}/objectschema/list`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list schemas (${resp.status}): ${await resp.text()}`
      );
    }
    const data = (await resp.json()) as { objectschemas: AssetSchema[] };
    return data.objectschemas;
  }

  /**
   * List object types within a schema.
   */
  async listObjectTypes(schemaId: number): Promise<AssetObjectType[]> {
    const resp = await this.fetch(
      `${this.insightUrl}/objectschema/${schemaId}/objecttypes`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list object types for schema ${schemaId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as AssetObjectType[];
  }

  // ---------------------------------------------------------------------------
  // Convenience: Find application by name or acronym
  // ---------------------------------------------------------------------------

  /**
   * Search for an application by name or acronym.
   * Searches the label field which follows the pattern "ACRONYM - Full Name".
   */
  async findApplication(nameOrKey: string): Promise<AssetObject | null> {
    // Try exact match on label first, then LIKE match
    const escaped = nameOrKey.replace(/"/g, '\\"');
    const result = await this.searchAql(
      `objectType = "Applications" AND Name LIKE "${escaped}"`,
      { resultsPerPage: 5 }
    );

    if (result.objectEntries.length > 0) {
      return result.objectEntries[0]!;
    }

    // Fallback: search across label (acronym - name format)
    const fallback = await this.searchAql(
      `objectType = "Applications" AND label LIKE "${escaped}"`,
      { resultsPerPage: 5 }
    );

    return fallback.objectEntries.length > 0
      ? fallback.objectEntries[0]!
      : null;
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the display value of a named attribute from an object.
   */
  getAttributeValue(obj: AssetObject, attrName: string): string | null {
    const attr = obj.attributes.find(
      (a) =>
        a.objectTypeAttribute?.name?.toLowerCase() ===
        attrName.toLowerCase()
    );
    if (!attr || attr.objectAttributeValues.length === 0) return null;

    return attr.objectAttributeValues
      .map((v) => v.displayValue ?? String(v.value))
      .join(", ");
  }

  /**
   * Extract all referenced objects for a named attribute.
   */
  getReferencedObjects(
    obj: AssetObject,
    attrName: string
  ): Array<{ id: number; label: string }> {
    const attr = obj.attributes.find(
      (a) =>
        a.objectTypeAttribute?.name?.toLowerCase() ===
        attrName.toLowerCase()
    );
    if (!attr) return [];

    return attr.objectAttributeValues
      .filter((v) => v.referencedObject != null)
      .map((v) => ({
        id: v.referencedObject!.id,
        label: v.referencedObject!.label,
      }));
  }

  /**
   * Format an asset object into readable markdown.
   */
  formatObjectAsMarkdown(obj: AssetObject): string {
    const lines: string[] = [];
    const url = `${this.baseUrl}/secure/insight/assets/${obj.objectKey}`;

    lines.push(`## ${obj.label}`);
    lines.push(`**Key:** ${obj.objectKey}`);
    lines.push(`**Type:** ${obj.objectType.name}`);
    lines.push(
      `**URL:** [View in Assets](${url})`
    );
    lines.push(`**Created:** ${obj.created.split("T")[0]}`);
    lines.push(`**Updated:** ${obj.updated.split("T")[0]}`);
    lines.push("");

    for (const attr of obj.attributes) {
      const name = attr.objectTypeAttribute?.name ?? `Attribute ${attr.id}`;
      if (attr.objectAttributeValues.length === 0) continue;

      const values = attr.objectAttributeValues
        .map((v) => {
          if (v.referencedObject) return v.referencedObject.label;
          return v.displayValue ?? String(v.value);
        })
        .join(", ");

      lines.push(`- **${name}:** ${values}`);
    }

    return lines.join("\n");
  }
}
