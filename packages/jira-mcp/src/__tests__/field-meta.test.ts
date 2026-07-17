import { describe, it, expect } from "vitest";
import {
  resolveCustomFields,
  formatFieldMeta,
  type JiraFieldMeta,
} from "../field-meta.js";

/** Field metadata fixtures mirroring BC Gov Jira RFC/RFD field shapes. */
const META: JiraFieldMeta[] = [
  {
    fieldId: "customfield_11702",
    name: "Target environment",
    required: true,
    schema: { type: "option", custom: "select" },
    allowedValues: [
      { id: "1", value: "DLVR" },
      { id: "2", value: "TEST" },
      { id: "3", value: "PROD" },
    ],
  },
  {
    fieldId: "customfield_10637",
    name: "Change Coordinator",
    required: true,
    schema: { type: "user" },
  },
  {
    fieldId: "customfield_11500",
    name: "RFD start date & time",
    required: false,
    schema: { type: "datetime" },
  },
  {
    fieldId: "customfield_12000",
    name: "Deployment Categories",
    required: false,
    schema: { type: "array", items: "option" },
    allowedValues: [
      { id: "10", value: "Application deployment" },
      { id: "11", value: "Database change" },
    ],
  },
  {
    fieldId: "customfield_13000",
    name: "Business Impact",
    required: false,
    schema: { type: "string" },
  },
  {
    fieldId: "fixVersions",
    name: "Fix Version/s",
    required: false,
    schema: { type: "array", items: "version" },
    allowedValues: [{ id: "20", name: "1.2.19" }],
  },
];

describe("resolveCustomFields", () => {
  it("resolves a select field by display name into {value} under its field ID", () => {
    const result = resolveCustomFields({ "Target environment": "PROD" }, META);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_11702: { value: "PROD" } });
  });

  it("matches field names case-insensitively", () => {
    const result = resolveCustomFields({ "target ENVIRONMENT": "TEST" }, META);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_11702: { value: "TEST" } });
  });

  it("accepts a raw customfield_* ID as the key", () => {
    const result = resolveCustomFields({ customfield_11702: "DLVR" }, META);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_11702: { value: "DLVR" } });
  });

  it("canonicalizes option values case-insensitively against allowedValues", () => {
    const result = resolveCustomFields({ "Target environment": "prod" }, META);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_11702: { value: "PROD" } });
  });

  it("rejects an option value not in allowedValues, listing what is allowed", () => {
    const result = resolveCustomFields({ "Target environment": "STAGING" }, META);
    expect(result.fields).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"STAGING"');
    expect(result.errors[0]).toContain("Target environment");
    expect(result.errors[0]).toContain("DLVR");
    expect(result.errors[0]).toContain("PROD");
  });

  it("shapes user fields as {name}", () => {
    const result = resolveCustomFields({ "Change Coordinator": "jdoe" }, META);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_10637: { name: "jdoe" } });
  });

  it("passes datetime and string values through unchanged", () => {
    const result = resolveCustomFields(
      {
        "RFD start date & time": "2026-07-20T14:00:00.000-0700",
        "Business Impact": "None expected",
      },
      META
    );
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({
      customfield_11500: "2026-07-20T14:00:00.000-0700",
      customfield_13000: "None expected",
    });
  });

  it("wraps a scalar into a single-element array for array-of-option fields", () => {
    const result = resolveCustomFields(
      { "Deployment Categories": "Database change" },
      META
    );
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({
      customfield_12000: [{ value: "Database change" }],
    });
  });

  it("shapes each element of an array value", () => {
    const result = resolveCustomFields(
      { "Deployment Categories": ["Application deployment", "Database change"] },
      META
    );
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({
      customfield_12000: [
        { value: "Application deployment" },
        { value: "Database change" },
      ],
    });
  });

  it("shapes name-keyed allowedValues (versions) as {name}", () => {
    const result = resolveCustomFields({ "Fix Version/s": "1.2.19" }, META);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ fixVersions: [{ name: "1.2.19" }] });
  });

  it("shapes name-keyed types as {name} when allowedValues is absent", () => {
    const meta: JiraFieldMeta[] = [
      {
        fieldId: "fixVersions",
        name: "Fix Version/s",
        required: false,
        schema: { type: "array", items: "version" },
        // Jira can omit allowedValues (e.g. large lists, some edit screens).
      },
      {
        fieldId: "priority",
        name: "Priority",
        required: false,
        schema: { type: "priority" },
      },
      {
        fieldId: "components",
        name: "Component/s",
        required: false,
        schema: { type: "array", items: "component" },
      },
    ];
    const result = resolveCustomFields(
      { "Fix Version/s": "1.2.19", Priority: "High", "Component/s": "Oracle" },
      meta
    );
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({
      fixVersions: [{ name: "1.2.19" }],
      priority: { name: "High" },
      components: [{ name: "Oracle" }],
    });
  });

  it("shapes option types as {value} when allowedValues is absent", () => {
    const meta: JiraFieldMeta[] = [
      {
        fieldId: "customfield_500",
        name: "Some Select",
        required: false,
        schema: { type: "option" },
      },
    ];
    const result = resolveCustomFields({ "Some Select": "Yes" }, meta);
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_500: { value: "Yes" } });
  });

  it("passes already-shaped object values through untouched", () => {
    const result = resolveCustomFields(
      { "Target environment": { id: "3" } },
      META
    );
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ customfield_11702: { id: "3" } });
  });

  describe("cascading selects (option-with-child)", () => {
    const cascadingMeta: JiraFieldMeta[] = [
      {
        fieldId: "customfield_12203",
        name: "Infrastructure Considerations",
        required: true,
        schema: { type: "option-with-child", custom: "cascadingselect" },
        allowedValues: [
          { id: "1", value: "No" },
          {
            id: "2",
            value: "Yes",
            children: [
              { id: "21", value: "Network" },
              { id: "22", value: "Storage" },
            ],
          },
        ],
      },
    ];

    it("shapes a plain string as the parent {value}, canonicalized", () => {
      const result = resolveCustomFields(
        { "Infrastructure Considerations": "no" },
        cascadingMeta
      );
      expect(result.errors).toEqual([]);
      expect(result.fields).toEqual({ customfield_12203: { value: "No" } });
    });

    it("shapes {parent, child} into {value, child: {value}}, both canonicalized", () => {
      const result = resolveCustomFields(
        { "Infrastructure Considerations": { parent: "yes", child: "network" } },
        cascadingMeta
      );
      expect(result.errors).toEqual([]);
      expect(result.fields).toEqual({
        customfield_12203: { value: "Yes", child: { value: "Network" } },
      });
    });

    it("rejects an unknown parent, listing allowed parents", () => {
      const result = resolveCustomFields(
        { "Infrastructure Considerations": "Maybe" },
        cascadingMeta
      );
      expect(result.fields).toEqual({});
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('"Maybe"');
      expect(result.errors[0]).toContain("No");
      expect(result.errors[0]).toContain("Yes");
    });

    it("rejects an unknown child, listing that parent's children", () => {
      const result = resolveCustomFields(
        { "Infrastructure Considerations": { parent: "Yes", child: "Compute" } },
        cascadingMeta
      );
      expect(result.fields).toEqual({});
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('"Compute"');
      expect(result.errors[0]).toContain("Network");
      expect(result.errors[0]).toContain("Storage");
    });

    it("rejects a missing/empty parent instead of coercing to 'undefined'", () => {
      for (const bad of [{ parent: undefined }, { parent: null }, { parent: "  " }, null]) {
        const result = resolveCustomFields(
          { "Infrastructure Considerations": bad },
          cascadingMeta
        );
        expect(result.fields).toEqual({});
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("Infrastructure Considerations");
        expect(result.errors[0]).toContain("parent");
      }
    });

    it("still passes pre-shaped {value} objects through untouched", () => {
      const result = resolveCustomFields(
        { "Infrastructure Considerations": { value: "No" } },
        cascadingMeta
      );
      expect(result.errors).toEqual([]);
      expect(result.fields).toEqual({ customfield_12203: { value: "No" } });
    });
  });

  it("reports unknown field names, listing available editable fields", () => {
    const result = resolveCustomFields({ "No Such Field": "x" }, META);
    expect(result.fields).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"No Such Field"');
    expect(result.errors[0]).toContain("Target environment");
  });

  it("collects multiple errors while still resolving valid fields", () => {
    const result = resolveCustomFields(
      {
        "Target environment": "PROD",
        "No Such Field": "x",
        "Deployment Categories": "Bad category",
      },
      META
    );
    expect(result.fields).toEqual({ customfield_11702: { value: "PROD" } });
    expect(result.errors).toHaveLength(2);
  });
});

describe("formatFieldMeta", () => {
  it("lists required fields first with ID, type, and allowed values", () => {
    const text = formatFieldMeta(META);
    const lines = text.split("\n");

    // Required fields come before optional ones.
    const targetEnvIdx = lines.findIndex((l) => l.includes("Target environment"));
    const businessIdx = lines.findIndex((l) => l.includes("Business Impact"));
    expect(targetEnvIdx).toBeGreaterThanOrEqual(0);
    expect(businessIdx).toBeGreaterThan(targetEnvIdx);

    const targetEnvLine = lines[targetEnvIdx];
    expect(targetEnvLine).toContain("customfield_11702");
    expect(targetEnvLine).toContain("required");
    expect(targetEnvLine).toContain("option");
    expect(targetEnvLine).toContain("DLVR, TEST, PROD");
  });

  it("truncates long allowed-value lists", () => {
    const many: JiraFieldMeta = {
      fieldId: "customfield_999",
      name: "Big List",
      required: false,
      schema: { type: "option" },
      allowedValues: Array.from({ length: 30 }, (_, i) => ({
        id: String(i),
        value: `Option ${i}`,
      })),
    };
    const text = formatFieldMeta([many]);
    expect(text).toContain("Option 0");
    expect(text).toContain("… (30 total)");
    expect(text).not.toContain("Option 29");
  });
});
