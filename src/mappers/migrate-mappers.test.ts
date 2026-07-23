import { describe, expect, it } from "vitest";
import { normalizeImportConfig } from "../config.js";
import { mapClausesToGrowthBook } from "./clauses.js";
import {
  planEnvironmentUpsert,
  planEnvironmentsForProjects,
} from "./environments.js";
import {
  buildFeatureFromLdFlag,
  inferValueType,
  resolveDefaultValue,
} from "./features.js";
import { matchOrPlanCreateProject } from "./projects.js";
import {
  buildRuleId,
  buildRulesFromLdEnvironment,
  consolidateEquivalentForceRules,
  mergeImportedRules,
} from "./rules.js";
import {
  buildSavedGroupName,
  planSegmentUpsert,
} from "./segments.js";
import type { LaunchDarklyFlagDetail } from "../types/migrate.js";

describe("matchOrPlanCreateProject", () => {
  it("matches by publicId in auto strategy", () => {
    const decision = matchOrPlanCreateProject({
      ldProject: { key: "billing", name: "Billing" },
      gbProjects: [{ id: "prj_1", name: "Other", publicId: "billing" }],
      strategy: "auto",
      projectMap: {},
      allowCreate: true,
    });

    expect(decision.action).toBe("matched");
    if (decision.action === "matched") {
      expect(decision.gbProject.id).toBe("prj_1");
    }
  });

  it("plans create when unmatched and allowCreate", () => {
    const decision = matchOrPlanCreateProject({
      ldProject: { key: "new-app", name: "New App" },
      gbProjects: [],
      strategy: "auto",
      projectMap: {},
      allowCreate: true,
    });

    expect(decision).toEqual({
      action: "create",
      publicId: "new-app",
      name: "New App",
    });
  });

  it("uses effective key/name from config remap for create and match", () => {
    const createDecision = matchOrPlanCreateProject({
      ldProject: { key: "old", name: "Old" },
      gbProjects: [],
      strategy: "auto",
      projectMap: {},
      allowCreate: true,
      effectiveKey: "new-key",
      effectiveName: "New Name",
    });

    expect(createDecision).toEqual({
      action: "create",
      publicId: "new-key",
      name: "New Name",
    });

    const matchDecision = matchOrPlanCreateProject({
      ldProject: { key: "old", name: "Old" },
      gbProjects: [{ id: "prj_1", name: "New Name", publicId: "new-key" }],
      strategy: "auto",
      projectMap: {},
      allowCreate: false,
      effectiveKey: "new-key",
      effectiveName: "New Name",
    });

    expect(matchDecision.action).toBe("matched");
  });
});

describe("planEnvironmentUpsert", () => {
  it("matches existing environment by id", () => {
    const decision = planEnvironmentUpsert({
      ldEnvironment: { key: "production", name: "Production" },
      gbEnvironments: [{ id: "production", description: "Prod" }],
    });

    expect(decision.action).toBe("matched");
  });

  it("plans create for missing shared environment without project scope", () => {
    const decision = planEnvironmentUpsert({
      ldEnvironment: { key: "staging", name: "Staging" },
      gbEnvironments: [],
      gbProjectId: "prj_1",
      strategy: "shared",
    });

    expect(decision).toEqual({
      action: "create",
      id: "staging",
      description: "Staging",
      projects: undefined,
      ldEnvironmentKey: "staging",
      strategy: "shared",
    });
  });

  it("plans create for unique environment scoped to project", () => {
    const decision = planEnvironmentUpsert({
      ldEnvironment: { key: "production", name: "Production" },
      gbEnvironments: [],
      gbProjectId: "prj_1",
      effectiveId: "app-b-prod",
      effectiveDescription: "App B Prod",
      strategy: "unique",
      ldProjectKey: "app-b",
    });

    expect(decision).toEqual({
      action: "create",
      id: "app-b-prod",
      description: "App B Prod",
      projects: ["prj_1"],
      ldProjectKey: "app-b",
      ldEnvironmentKey: "production",
      strategy: "unique",
    });
  });
});

describe("planEnvironmentsForProjects", () => {
  it("dedupes shared envs and keeps unique envs per project", () => {
    const config = normalizeImportConfig({
      projects: {
        remap: {
          "app-a": { environmentStrategy: "shared" },
          "app-b": {
            environmentStrategy: "unique",
            environments: {
              remap: {
                production: { key: "app-b-prod", name: "B Prod" },
              },
            },
          },
        },
      },
      environments: {
        remap: { production: { key: "prod", name: "Production" } },
      },
    });

    const planned = planEnvironmentsForProjects({
      config,
      ldEnvsByProject: new Map([
        ["app-a", [{ key: "production", name: "Production" }]],
        ["app-b", [{ key: "production", name: "Production" }]],
        ["app-c", [{ key: "production", name: "Production" }]],
      ]),
      activeProjectKeys: ["app-a", "app-b", "app-c"],
    });

    const shared = planned.filter((item) => item.strategy === "shared");
    const unique = planned.filter((item) => item.strategy === "unique");

    expect(shared).toHaveLength(1);
    expect(shared[0]?.effectiveId).toBe("prod");
    expect(unique).toHaveLength(1);
    expect(unique[0]?.effectiveId).toBe("app-b-prod");
    expect(unique[0]?.ldProjectKey).toBe("app-b");
  });
});

describe("mapClausesToGrowthBook", () => {
  it("maps in / endsWith / segmentMatch", () => {
    const result = mapClausesToGrowthBook({
      clauses: [
        {
          attribute: "email",
          op: "endsWith",
          values: ["@acme.com"],
          negate: false,
        },
        {
          attribute: "country",
          op: "in",
          values: ["BR", "US"],
          negate: false,
        },
        {
          attribute: "segment",
          op: "segmentMatch",
          values: ["beta"],
          negate: false,
        },
      ],
      resolveSavedGroupId: (key) =>
        key === "beta" ? "sg_beta" : undefined,
    });

    expect(result.unsupported).toEqual([]);
    expect(result.condition).toEqual({
      $and: [
        { email: { $regex: "@acme\\.com$" } },
        { country: { $in: ["BR", "US"] } },
      ],
    });
    expect(result.savedGroupTargeting).toEqual([
      { matchType: "all", savedGroups: ["sg_beta"] },
    ]);
  });

  it("reports unsupported operators", () => {
    const result = mapClausesToGrowthBook({
      clauses: [
        {
          attribute: "custom",
          op: "unknownOp",
          values: ["x"],
          negate: false,
        },
      ],
    });

    expect(result.unsupported).toContain("unknownOp:custom");
    expect(result.condition).toBeUndefined();
  });
});

describe("planSegmentUpsert", () => {
  it("creates list saved group for included keys", () => {
    const decision = planSegmentUpsert({
      ldProjectKey: "app",
      environmentKey: "production",
      segment: {
        key: "vip",
        name: "VIP",
        included: ["u1", "u2"],
      },
      existingSavedGroups: [],
      gbProjectId: "prj_1",
      listAttributeKey: "id",
    });

    expect(decision.action).toBe("create");
    if (decision.action === "create") {
      expect(decision.payload.type).toBe("list");
      expect(decision.payload.values).toEqual(["u1", "u2"]);
      expect(decision.savedGroupName).toBe(
        buildSavedGroupName({
          ldProjectKey: "app",
          environmentKey: "production",
          segmentKey: "vip",
        }),
      );
    }
  });

  it("marks unbounded segments unsupported", () => {
    const decision = planSegmentUpsert({
      ldProjectKey: "app",
      environmentKey: "production",
      segment: {
        key: "big",
        name: "Big",
        unbounded: true,
      },
      existingSavedGroups: [],
      listAttributeKey: "id",
    });

    expect(decision.action).toBe("unsupported");
  });
});

describe("buildRulesFromLdEnvironment", () => {
  const flag: LaunchDarklyFlagDetail = {
    key: "checkout-v2",
    kind: "boolean",
    variations: [{ value: false }, { value: true }],
  };

  it("builds enabled force/rollout rules with stable ids", () => {
    const result = buildRulesFromLdEnvironment({
      ldProjectKey: "app",
      ldFlag: flag,
      environmentKey: "production",
      valueType: "boolean",
      envConfig: {
        on: true,
        targets: [{ variation: 1, values: ["user-1"] }],
        rules: [
          {
            _id: "rule-1",
            description: "email rule",
            clauses: [
              {
                attribute: "email",
                op: "endsWith",
                values: ["@acme.com"],
                negate: false,
              },
            ],
            variation: 1,
          },
        ],
        fallthrough: {
          rollout: {
            variations: [
              { variation: 0, weight: 50000 },
              { variation: 1, weight: 50000 },
            ],
          },
        },
        offVariation: 0,
        prerequisites: [{ key: "gate-flag", variation: 1 }],
      },
    });

    expect(result.prerequisiteKeys).toEqual(["gate-flag"]);
    expect(result.rules.length).toBe(3);
    expect(result.rules.every((rule) => rule.enabled === true)).toBe(true);
    expect(result.rules[0]?.type).toBe("force");
    expect(result.rules[1]?.type).toBe("force");
    expect(result.rules[2]?.type).toBe("rollout");
    expect(result.rules[0]?.id).toBe(
      buildRuleId("app", "checkout-v2", "production", "target-0-1"),
    );
  });

  it("consolidates equivalent fallthrough force rules across environments", () => {
    const flag: LaunchDarklyFlagDetail = {
      key: "walletInitialState",
      kind: "boolean",
      variations: [
        { name: "true", value: true },
        { name: "false", value: false },
      ],
      environments: {
        "lottoland-production": {
          on: true,
          offVariation: 1,
          fallthrough: { variation: 1 },
        },
        "lottoland-staging": {
          on: false,
          offVariation: 1,
          fallthrough: { variation: 1 },
        },
        production: {
          on: false,
          offVariation: 1,
          fallthrough: { variation: 1 },
        },
        test: {
          on: true,
          offVariation: 1,
          fallthrough: { variation: 0 },
        },
      },
    };

    const built = buildFeatureFromLdFlag({
      ldProjectKey: "default",
      ldFlag: flag,
      gbProjectId: "prj_1",
      owner: "ld-migrate",
      resolveSavedGroupIdForEnv: () => undefined,
      envKeyMap: new Map([
        ["lottoland-production", "lottoland-production"],
        ["lottoland-staging", "lottoland-staging"],
        ["production", "sorte-online-production"],
        ["test", "sorte-online-staging"],
      ]),
    });

    expect(built.importedRules).toHaveLength(2);
    expect(built.importedRules.every((rule) => rule.enabled === true)).toBe(
      true,
    );

    const byValue = new Map(
      built.importedRules.map((rule) => [String(rule.value), rule]),
    );
    expect(byValue.get("true")?.environments?.sort()).toEqual([
      "sorte-online-staging",
    ]);
    expect(byValue.get("true")?.description).toBe("true");
    expect(byValue.get("false")?.environments?.sort()).toEqual([
      "lottoland-production",
      "lottoland-staging",
      "sorte-online-production",
    ]);
    expect(byValue.get("false")?.description).toBe("false");
  });

  it("uses LD variation names as fallthrough rule descriptions", () => {
    const flag: LaunchDarklyFlagDetail = {
      key: "configureSuperBolaoPreview",
      kind: "multivariate",
      variations: [
        { name: "enable", value: { mode: "enable" } },
        { name: "disable", value: { mode: "disable" } },
        { name: "[STG] enable", value: { mode: "stg" } },
      ],
      environments: {
        "lottoland-production": {
          on: true,
          fallthrough: { variation: 1 },
        },
        "lottoland-staging": {
          on: true,
          fallthrough: { variation: 0 },
        },
        production: {
          on: true,
          fallthrough: { variation: 1 },
        },
        test: {
          on: true,
          fallthrough: { variation: 2 },
        },
      },
    };

    const built = buildFeatureFromLdFlag({
      ldProjectKey: "default",
      ldFlag: flag,
      gbProjectId: "prj_1",
      owner: "ld-migrate",
      resolveSavedGroupIdForEnv: () => undefined,
      envKeyMap: new Map([
        ["lottoland-production", "lottoland-production"],
        ["lottoland-staging", "lottoland-staging"],
        ["production", "sorte-online-production"],
        ["test", "sorte-online-staging"],
      ]),
    });

    const names = built.importedRules.map((rule) => rule.description).sort();
    expect(names).toEqual(["[STG] enable", "disable", "enable"]);
    expect(
      built.importedRules.find((rule) => rule.description === "disable")
        ?.environments?.sort(),
    ).toEqual(["lottoland-production", "sorte-online-production"]);
  });

  it("falls back to LD fallthrough when variation has no name", () => {
    const result = buildRulesFromLdEnvironment({
      ldProjectKey: "app",
      ldFlag: {
        key: "unnamed",
        variations: [{ value: true }],
      },
      environmentKey: "production",
      valueType: "boolean",
      envConfig: {
        fallthrough: { variation: 0 },
      },
    });

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.description).toBe("LD fallthrough");
    expect(result.rules[0]?.enabled).toBe(true);
  });

  it("is idempotent for mergeImportedRules", () => {
    const built = buildRulesFromLdEnvironment({
      ldProjectKey: "app",
      ldFlag: flag,
      environmentKey: "production",
      valueType: "boolean",
      envConfig: {
        fallthrough: { variation: 1 },
      },
    });

    const first = mergeImportedRules({
      existingRules: [],
      importedRules: built.rules,
    });
    const second = mergeImportedRules({
      existingRules: first.rules,
      importedRules: built.rules,
    });

    expect(first.createdCount).toBe(1);
    expect(second.createdCount).toBe(0);
    expect(second.replacedCount).toBe(1);
    expect(second.rules).toHaveLength(1);
  });

  it("drops legacy empty-condition force rules superseded by renamed imports", () => {
    const legacy = {
      id: "ld-rule-fallthrough-legacy",
      description: "LD fallthrough",
      condition: "",
      enabled: true,
      type: "force",
      value: "false",
      environments: ["lottoland-production", "sorte-online-production"],
    };
    const imported = consolidateEquivalentForceRules({
      ldProjectKey: "default",
      flagKey: "walletInitialState",
      valueType: "boolean",
      rules: [
        {
          id: "tmp-a",
          description: "false",
          condition: "",
          enabled: true,
          type: "force",
          value: "false",
          environments: ["lottoland-production"],
        },
        {
          id: "tmp-b",
          description: "false",
          condition: "",
          enabled: true,
          type: "force",
          value: "false",
          environments: ["sorte-online-production"],
        },
      ],
    });

    const merge = mergeImportedRules({
      existingRules: [legacy],
      importedRules: imported,
      valueType: "boolean",
    });

    expect(merge.rules).toHaveLength(1);
    expect(merge.rules[0]?.description).toBe("false");
    expect(merge.rules[0]?.environments?.sort()).toEqual([
      "lottoland-production",
      "sorte-online-production",
    ]);
    expect(merge.rules.some((rule) => rule.id === legacy.id)).toBe(false);
    expect(merge.changed).toBe(true);
  });
});

describe("feature mapping", () => {
  it("infers value type and default from offVariation", () => {
    const flag: LaunchDarklyFlagDetail = {
      key: "json-flag",
      kind: "multivariate",
      variations: [
        { name: "v1", value: { a: 1 } },
        { name: "v2", value: { a: 2 } },
      ],
      environments: {
        production: {
          on: false,
          offVariation: 0,
          fallthrough: { variation: 1 },
        },
      },
    };

    expect(inferValueType(flag)).toBe("json");
    expect(resolveDefaultValue({ flag, valueType: "json" })).toBe('{"a":1}');

    const built = buildFeatureFromLdFlag({
      ldProjectKey: "app",
      ldFlag: flag,
      gbProjectId: "prj_1",
      owner: "ld-migrate",
      resolveSavedGroupIdForEnv: () => undefined,
    });

    expect(built.createPayload.owner).toBe("ld-migrate");

    expect(built.createPayload.environments.production?.enabled).toBe(false);
    expect(built.importedRules.every((rule) => rule.enabled === true)).toBe(
      true,
    );
    expect(built.importedRules[0]?.description).toBe("v2");
  });

  it("maps environment on toggle separately from fallthrough value", () => {
    const flag: LaunchDarklyFlagDetail = {
      key: "walletInitialState",
      kind: "boolean",
      variations: [
        { name: "true", value: true },
        { name: "false", value: false },
      ],
      environments: {
        "lottoland-production": {
          on: true,
          offVariation: 1,
          fallthrough: { variation: 1 },
        },
        test: {
          on: true,
          offVariation: 1,
          fallthrough: { variation: 0 },
        },
      },
    };

    const built = buildFeatureFromLdFlag({
      ldProjectKey: "default",
      ldFlag: flag,
      gbProjectId: "prj_1",
      owner: "ld-migrate",
      resolveSavedGroupIdForEnv: () => undefined,
      envKeyMap: new Map([
        ["lottoland-production", "lottoland-production"],
        ["test", "sorte-online-staging"],
      ]),
    });

    expect(built.createPayload.environments["lottoland-production"]?.enabled).toBe(
      true,
    );
    expect(built.createPayload.environments["sorte-online-staging"]?.enabled).toBe(
      true,
    );
    expect(built.defaultValue).toBe("false");

    const byValue = new Map(
      built.importedRules.map((rule) => [String(rule.value), rule]),
    );
    expect(byValue.get("false")?.environments).toEqual(["lottoland-production"]);
    expect(byValue.get("true")?.environments).toEqual(["sorte-online-staging"]);
  });
});
