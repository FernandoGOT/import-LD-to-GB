import { describe, expect, it } from "vitest";
import {
  type GrowthBookFeature,
  type GrowthBookRule,
  type LaunchDarklyFlag,
  type LaunchDarklyProject,
  type LaunchDarklyVariation,
  buildDisabledGrowthBookRule,
  buildRuleIdForVariation,
  findMissingLdVariations,
  getFeatureRules,
  mergeRulesWithoutDuplicates,
  syncFeatureRules,
  uniqueLdVariationsByValue,
} from "./variation-dedupe.js";

const ldProject: LaunchDarklyProject = {
  key: "default",
  name: "Default",
};

const ldFlag: LaunchDarklyFlag = {
  key: "my-flag",
};

const targetEnvs = ["production", "dev", "staging"];

function makeFeature(
  overrides: Partial<GrowthBookFeature> = {},
): GrowthBookFeature {
  return {
    id: "my-flag",
    valueType: "boolean",
    defaultValue: "false",
    rules: [],
    environments: {
      production: { enabled: true, defaultValue: "false" },
      dev: { enabled: true, defaultValue: "false" },
      staging: { enabled: true, defaultValue: "false" },
    },
    ...overrides,
  };
}

describe("uniqueLdVariationsByValue", () => {
  it("deduplicates boolean true and string true for boolean valueType", () => {
    const variations: LaunchDarklyVariation[] = [
      { key: "a", name: "A", value: true },
      { key: "b", name: "B", value: "true" },
      { key: "c", name: "C", value: false },
    ];

    const unique = uniqueLdVariationsByValue(variations, "boolean");

    expect(unique).toHaveLength(2);
    expect(unique[0]?.key).toBe("a");
    expect(unique[1]?.key).toBe("c");
  });

  it("keeps distinct json objects", () => {
    const variations: LaunchDarklyVariation[] = [
      { key: "a", value: { b: 1, a: 2 } },
      { key: "b", value: { a: 2, b: 1 } },
      { key: "c", value: { a: 3 } },
    ];

    const unique = uniqueLdVariationsByValue(variations, "json");

    expect(unique).toHaveLength(2);
    expect(unique.map((v) => v.key)).toEqual(["a", "c"]);
  });
});

describe("getFeatureRules", () => {
  it("prefers top-level rules", () => {
    const feature = makeFeature({
      rules: [{ id: "top", type: "force", value: "true" }],
      environments: {
        production: {
          enabled: true,
          rules: [{ id: "nested", type: "force", value: "false" }],
        },
      },
    });

    expect(getFeatureRules(feature).map((r) => r.id)).toEqual(["top"]);
  });

  it("flattens legacy per-env rules when top-level is absent", () => {
    const feature = makeFeature({
      rules: undefined,
      environments: {
        production: {
          enabled: true,
          rules: [{ id: "a", type: "force", value: "true" }],
        },
        dev: {
          enabled: true,
          rules: [{ id: "b", type: "force", value: "false" }],
        },
      },
    });

    expect(getFeatureRules(feature).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("findMissingLdVariations", () => {
  it("skips values already present as defaultValue", () => {
    const feature = makeFeature({
      valueType: "string",
      defaultValue: "control",
      rules: [],
      environments: {
        production: {
          enabled: true,
          defaultValue: "control",
        },
      },
    });

    const missing = findMissingLdVariations({
      ldVariations: [
        { key: "v1", name: "Control", value: "control" },
        { key: "v2", name: "Treatment", value: "treatment" },
      ],
      feature,
      ldProjectKey: ldProject.key,
      flagKey: ldFlag.key,
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]?.value).toBe("treatment");
  });

  it("skips values already present in a top-level force rule", () => {
    const feature = makeFeature({
      valueType: "boolean",
      rules: [
        {
          id: "existing-force",
          type: "force",
          enabled: false,
          value: "true",
          environments: ["production", "dev"],
        },
      ],
    });

    const missing = findMissingLdVariations({
      ldVariations: [
        { key: "on", name: "On", value: true },
        { key: "off", name: "Off", value: false },
      ],
      feature,
      ldProjectKey: ldProject.key,
      flagKey: ldFlag.key,
    });

    expect(missing).toHaveLength(0);
  });

  it("skips values present in nested experiment rule values", () => {
    const feature = makeFeature({
      valueType: "string",
      defaultValue: "a",
      rules: [
        {
          id: "exp-1",
          type: "experiment",
          value: [{ value: "b" }, { value: "c" }],
          environments: ["production"],
        },
      ],
    });

    const missing = findMissingLdVariations({
      ldVariations: [
        { key: "1", value: "b" },
        { key: "2", value: "c" },
        { key: "3", value: "d" },
      ],
      feature,
      ldProjectKey: ldProject.key,
      flagKey: ldFlag.key,
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]?.value).toBe("d");
  });

  it("skips when rule id already exists even if value format differs", () => {
    const variation: LaunchDarklyVariation = {
      key: "uuid-1",
      name: "On",
      value: true,
    };
    const ruleId = buildRuleIdForVariation(
      ldProject.key,
      ldFlag.key,
      variation,
    );

    const feature = makeFeature({
      valueType: "boolean",
      defaultValue: "false",
      rules: [
        {
          id: ruleId,
          type: "force",
          enabled: false,
          value: { weird: true },
          environments: ["production"],
        },
      ],
    });

    const missing = findMissingLdVariations({
      ldVariations: [variation],
      feature,
      ldProjectKey: ldProject.key,
      flagKey: ldFlag.key,
    });

    expect(missing).toHaveLength(0);
  });

  it("returns empty on second pass after imported rules exist", () => {
    const variations: LaunchDarklyVariation[] = [
      { key: "on", name: "On", value: true },
      { key: "off", name: "Off", value: false },
    ];

    const importedRules = variations.map((variation) =>
      buildDisabledGrowthBookRule({
        ldProject,
        ldFlag,
        gbFeature: makeFeature(),
        variation,
        environments: targetEnvs,
      }),
    );

    const feature = makeFeature({
      defaultValue: "maybe",
      valueType: "boolean",
      rules: importedRules,
    });

    const missing = findMissingLdVariations({
      ldVariations: uniqueLdVariationsByValue(variations, "boolean"),
      feature,
      ldProjectKey: ldProject.key,
      flagKey: ldFlag.key,
    });

    expect(missing).toHaveLength(0);
  });
});

describe("buildDisabledGrowthBookRule", () => {
  it("uses the original variation name as description and marks all target envs", () => {
    const rule = buildDisabledGrowthBookRule({
      ldProject,
      ldFlag,
      gbFeature: makeFeature(),
      variation: { key: "on", name: "On Variant", value: true },
      environments: targetEnvs,
    });

    expect(rule.description).toBe("On Variant");
    expect(rule.enabled).toBe(false);
    expect(rule.type).toBe("force");
    expect(rule.value).toBe("true");
    expect(rule.allEnvironments).toBe(false);
    expect(rule.environments).toEqual(targetEnvs);
  });
});

describe("syncFeatureRules", () => {
  it("creates one rule covering all target environments", () => {
    const newRule = buildDisabledGrowthBookRule({
      ldProject,
      ldFlag,
      gbFeature: makeFeature(),
      variation: { key: "on", name: "Force Rule", value: true },
      environments: targetEnvs,
    });

    const result = syncFeatureRules({
      existingRules: [],
      newRules: [newRule],
      targetEnvironments: targetEnvs,
      valueType: "boolean",
    });

    expect(result.createdCount).toBe(1);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.environments).toEqual(targetEnvs);
    expect(result.rules[0]?.allEnvironments).toBe(false);
  });

  it("does not create a second copy for the same variation across envs", () => {
    const variation: LaunchDarklyVariation = {
      key: "on",
      name: "Force Rule",
      value: true,
    };
    const rule = buildDisabledGrowthBookRule({
      ldProject,
      ldFlag,
      gbFeature: makeFeature(),
      variation,
      environments: targetEnvs,
    });

    const first = syncFeatureRules({
      existingRules: [],
      newRules: [rule],
      targetEnvironments: targetEnvs,
      valueType: "boolean",
    });

    const second = syncFeatureRules({
      existingRules: first.rules,
      newRules: [
        buildDisabledGrowthBookRule({
          ldProject,
          ldFlag,
          gbFeature: makeFeature(),
          variation,
          environments: targetEnvs,
        }),
      ],
      targetEnvironments: targetEnvs,
      valueType: "boolean",
    });

    expect(second.createdCount).toBe(0);
    expect(second.rules).toHaveLength(1);
    expect(second.changed).toBe(false);
  });

  it("consolidates legacy per-env copies with the same import id", () => {
    const variation: LaunchDarklyVariation = {
      key: "on",
      name: "Force Rule",
      value: true,
    };
    const ruleId = buildRuleIdForVariation(
      ldProject.key,
      ldFlag.key,
      variation,
    );

    const legacyCopies: GrowthBookRule[] = [
      {
        id: ruleId,
        type: "force",
        enabled: false,
        value: "true",
        environments: ["production"],
      },
      {
        id: ruleId,
        type: "force",
        enabled: false,
        value: "true",
        environments: ["dev"],
      },
      {
        id: ruleId,
        type: "force",
        enabled: false,
        value: "true",
        environments: ["staging"],
      },
    ];

    const result = syncFeatureRules({
      existingRules: legacyCopies,
      newRules: [],
      targetEnvironments: targetEnvs,
      valueType: "boolean",
    });

    expect(result.consolidatedCount).toBe(2);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.id).toBe(ruleId);
    expect(result.rules[0]?.environments?.sort()).toEqual(
      [...targetEnvs].sort(),
    );
  });

  it("expands an existing import rule that only covers some environments", () => {
    const variation: LaunchDarklyVariation = {
      key: "on",
      name: "Force Rule",
      value: true,
    };
    const existing = buildDisabledGrowthBookRule({
      ldProject,
      ldFlag,
      gbFeature: makeFeature(),
      variation,
      environments: ["production"],
    });

    const result = syncFeatureRules({
      existingRules: [existing],
      newRules: [],
      targetEnvironments: targetEnvs,
      valueType: "boolean",
    });

    expect(result.createdCount).toBe(0);
    expect(result.expandedCount).toBe(1);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.environments?.sort()).toEqual(
      [...targetEnvs].sort(),
    );
  });

  it("preserves unrelated manual rules when consolidating imports", () => {
    const variation: LaunchDarklyVariation = {
      key: "on",
      name: "Force Rule",
      value: true,
    };
    const ruleId = buildRuleIdForVariation(
      ldProject.key,
      ldFlag.key,
      variation,
    );

    const result = syncFeatureRules({
      existingRules: [
        {
          id: "manual-rule",
          type: "force",
          enabled: true,
          value: "false",
          environments: ["production"],
        },
        {
          id: ruleId,
          type: "force",
          enabled: false,
          value: "true",
          environments: ["production"],
        },
        {
          id: ruleId,
          type: "force",
          enabled: false,
          value: "true",
          environments: ["dev"],
        },
      ],
      newRules: [],
      targetEnvironments: targetEnvs,
      valueType: "boolean",
    });

    expect(result.rules).toHaveLength(2);
    const manual = result.rules.find((r) => r.id === "manual-rule");
    expect(manual?.environments).toEqual(["production"]);
  });
});

describe("mergeRulesWithoutDuplicates", () => {
  it("does not duplicate by id or canonical value", () => {
    const existing: GrowthBookRule[] = [
      {
        id: "keep-me",
        type: "force",
        value: "true",
        enabled: true,
      },
    ];

    const newRules: GrowthBookRule[] = [
      {
        id: "keep-me",
        type: "force",
        value: "true",
        enabled: false,
      },
      {
        id: "same-value-new-id",
        type: "force",
        value: true,
        enabled: false,
      },
      {
        id: "brand-new",
        type: "force",
        value: "false",
        enabled: false,
      },
    ];

    const merged = mergeRulesWithoutDuplicates(existing, newRules, "boolean");

    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe("keep-me");
    expect(merged[1]?.id).toBe("brand-new");
  });

  it("preserves all existing rules even if they duplicate each other when not import ids", () => {
    const existing: GrowthBookRule[] = [
      { id: "a", type: "force", value: "true" },
      { id: "b", type: "force", value: "true" },
    ];

    const merged = mergeRulesWithoutDuplicates(
      existing,
      [{ id: "c", type: "force", value: "true" }],
      "boolean",
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
