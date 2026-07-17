/**
 * Field metadata resolution for Jira create/edit screens.
 *
 * Jira's REST API wants custom fields keyed by ID (customfield_NNNNN) with
 * type-specific value shapes ({value} for selects, {name} for users, ...).
 * Callers know fields by their display name ("Target environment") and plain
 * values ("PROD"). This module bridges the two using createmeta/editmeta
 * field metadata, validating option values so mistakes fail with a readable
 * message instead of Jira's generic 400.
 */

/** Normalized field metadata from createmeta/editmeta. */
export interface JiraFieldMeta {
  fieldId: string;
  name: string;
  required: boolean;
  schema: { type: string; items?: string; custom?: string };
  allowedValues?: Array<Record<string, unknown>>;
}

export interface ResolveResult {
  /** Resolved fields keyed by field ID, ready for the Jira REST payload. */
  fields: Record<string, unknown>;
  /** Human-readable problems; when non-empty the caller should not submit. */
  errors: string[];
}

/**
 * Resolve display-named custom fields into a Jira REST fields payload.
 * Field keys match by ID or case-insensitive display name.
 */
export function resolveCustomFields(
  input: Record<string, unknown>,
  meta: JiraFieldMeta[]
): ResolveResult {
  const fields: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    const field = findField(key, meta);
    if (!field) {
      const available = meta.map((m) => m.name).sort().join(", ");
      errors.push(`Unknown field "${key}". Available fields: ${available}`);
      continue;
    }

    const shaped = shapeValue(value, field);
    if (shaped.error) {
      errors.push(shaped.error);
      continue;
    }
    fields[field.fieldId] = shaped.value;
  }

  return { fields, errors };
}

const MAX_ALLOWED_VALUES_SHOWN = 15;

/**
 * Render field metadata as a Markdown list for tool output: required fields
 * first, each with ID, type, and (truncated) allowed values.
 */
export function formatFieldMeta(meta: JiraFieldMeta[]): string {
  const sorted = [...meta].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return sorted
    .map((f) => {
      const type = f.schema.items
        ? `${f.schema.type} of ${f.schema.items}`
        : f.schema.type;
      let line = `- **${f.name}** (\`${f.fieldId}\`) — ${type}${f.required ? ", required" : ""}`;
      const labels = (f.allowedValues ?? [])
        .map((v) => v["value"] ?? v["name"] ?? v["id"])
        .filter((label) => typeof label === "string");
      if (labels.length > 0) {
        const shown = labels.slice(0, MAX_ALLOWED_VALUES_SHOWN).join(", ");
        const suffix =
          labels.length > MAX_ALLOWED_VALUES_SHOWN
            ? `, … (${labels.length} total)`
            : "";
        line += `. Allowed: ${shown}${suffix}`;
      }
      return line;
    })
    .join("\n");
}

function findField(key: string, meta: JiraFieldMeta[]): JiraFieldMeta | undefined {
  const lower = key.toLowerCase();
  return meta.find(
    (m) => m.fieldId.toLowerCase() === lower || m.name.toLowerCase() === lower
  );
}

function shapeValue(
  value: unknown,
  field: JiraFieldMeta
): { value?: unknown; error?: string } {
  // Caller already provided a REST-shaped object (e.g. {id}, {value}) — trust it.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { value };
  }

  if (field.schema.type === "array") {
    const items = Array.isArray(value) ? value : [value];
    const shaped: unknown[] = [];
    for (const item of items) {
      const one = shapeScalar(item, field.schema.items ?? "string", field);
      if (one.error) return one;
      shaped.push(one.value);
    }
    return { value: shaped };
  }

  return shapeScalar(value, field.schema.type, field);
}

function shapeScalar(
  value: unknown,
  type: string,
  field: JiraFieldMeta
): { value?: unknown; error?: string } {
  if (typeof value === "object" && value !== null) {
    return { value };
  }

  switch (type) {
    case "option":
      return shapeAgainstAllowedValues(value, field, "value");
    case "version":
    case "component":
    case "priority":
      return shapeAgainstAllowedValues(value, field, "name");
    case "user":
    case "group":
      return { value: { name: String(value) } };
    default:
      // string, number, date, datetime, any: Jira accepts the raw value.
      return { value };
  }
}

/**
 * Match a plain value against allowedValues case-insensitively and emit the
 * canonical {value}/{name} shape. When Jira omits allowedValues (common on
 * some edit screens / large lists) fall back to the shape the schema type
 * expects: {value} for options, {name} for versions/components/priorities.
 */
function shapeAgainstAllowedValues(
  value: unknown,
  field: JiraFieldMeta,
  fallbackKey: "value" | "name"
): { value?: unknown; error?: string } {
  const raw = String(value);
  const allowed = field.allowedValues;

  if (!allowed || allowed.length === 0) {
    return { value: { [fallbackKey]: raw } };
  }

  const lower = raw.toLowerCase();
  for (const entry of allowed) {
    const label = entry["value"] ?? entry["name"];
    if (typeof label === "string" && label.toLowerCase() === lower) {
      return {
        value: entry["value"] !== undefined ? { value: label } : { name: label },
      };
    }
  }

  const labels = allowed
    .map((entry) => entry["value"] ?? entry["name"])
    .filter((label) => typeof label === "string")
    .join(", ");
  return {
    error: `Invalid value "${raw}" for field "${field.name}". Allowed values: ${labels}`,
  };
}
