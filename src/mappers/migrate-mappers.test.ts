import { describe, expect, it } from "vitest";
import { mapClausesToGrowthBook } from "./clauses.js";
import { planEnvironmentUpsert } from "./environments.js";
import {
  buildFeatureFromLdFlag,
  inferValueType,
  resolveDefaultValue,
} from "./features.js";
import { matchOrPlanCreateProject } from "./projects.js";
import {
  buildRuleId,
  buildRulesFromLdEnvironment,
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
});

describe("planEnvironmentUpsert", () => {
  it("matches existing environment by id", () => {
    const decision = planEnvironmentUpsert({
      ldEnvironment: { key: "production", name: "Production" },
      gbEnvironments: [{ id: "production", description: "Prod" }],
    });

    expect(decision.action).toBe("matched");
  });

  it("plans create for missing environment", () => {
    const decision = planEnvironmentUpsert({
      ldEnvironment: { key: "staging", name: "Staging" },
      gbEnvironments: [],
      gbProjectId: "prj_1",
    });

    expect(decision).toEqual({
      action: "create",
      id: "staging",
      description: "Staging",
      projects: ["prj_1"],
    });
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

  it("builds disabled force/rollout rules with stable ids", () => {
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
    expect(result.rules.every((rule) => rule.enabled === false)).toBe(true);
    expect(result.rules[0]?.type).toBe("force");
    expect(result.rules[1]?.type).toBe("force");
    expect(result.rules[2]?.type).toBe("rollout");
    expect(result.rules[0]?.id).toBe(
      buildRuleId("app", "checkout-v2", "production", "target-0-1"),
    );
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
});

describe("feature mapping", () => {
  it("infers value type and default from offVariation", () => {
    const flag: LaunchDarklyFlagDetail = {
      key: "json-flag",
      kind: "multivariate",
      variations: [
        { value: { a: 1 } },
        { value: { a: 2 } },
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
    expect(built.importedRules.every((rule) => rule.enabled === false)).toBe(
      true,
    );
  });
});
