import {
  buildRulesFromLdEnvironment,
  mergeImportedRules,
} from "./rules.js";
import type { SegmentIdResolver } from "./clauses.js";
import {
  serializeGrowthBookValue,
  type GrowthBookFeature,
  type GrowthBookRule,
  type LaunchDarklyVariation,
} from "../variation-dedupe.js";
import type {
  CreateFeaturePayload,
  LaunchDarklyFlagDetail,
  RuleBuildWarning,
} from "../types/migrate.js";

export type FeatureBuildResult = {
  createPayload: CreateFeaturePayload;
  importedRules: GrowthBookRule[];
  warnings: RuleBuildWarning[];
  valueType: string;
  defaultValue: string;
};

export function inferValueType(
  flag: LaunchDarklyFlagDetail,
): "boolean" | "string" | "number" | "json" {
  if (flag.kind === "boolean") {
    return "boolean";
  }

  const variations = flag.variations ?? [];
  if (variations.length === 0) {
    return flag.kind === "multivariate" ? "string" : "boolean";
  }

  const types = new Set(variations.map((variation) => typeof variation.value));

  if (types.size === 1 && types.has("boolean")) return "boolean";
  if (types.size === 1 && types.has("number")) return "number";
  if (types.size === 1 && types.has("string")) return "string";

  return "json";
}

export function resolveDefaultValue(input: {
  flag: LaunchDarklyFlagDetail;
  valueType: string;
}): string {
  const variations = input.flag.variations ?? [];
  const envConfigs = Object.values(input.flag.environments ?? {});

  for (const env of envConfigs) {
    if (typeof env.offVariation === "number") {
      const value = variations[env.offVariation]?.value;
      if (value !== undefined) {
        return serializeGrowthBookValue(value, input.valueType);
      }
    }
  }

  if (typeof input.flag.defaults?.offVariation === "number") {
    const value = variations[input.flag.defaults.offVariation]?.value;
    if (value !== undefined) {
      return serializeGrowthBookValue(value, input.valueType);
    }
  }

  if (variations[0]) {
    return serializeGrowthBookValue(variations[0].value, input.valueType);
  }

  if (input.valueType === "boolean") return "false";
  if (input.valueType === "number") return "0";
  if (input.valueType === "json") return "{}";
  return "";
}

export function buildFeatureFromLdFlag(input: {
  ldProjectKey: string;
  ldFlag: LaunchDarklyFlagDetail;
  gbProjectId: string;
  owner: string;
  resolveSavedGroupIdForEnv: (
    environmentKey: string,
  ) => SegmentIdResolver | undefined;
}): FeatureBuildResult {
  const valueType = inferValueType(input.ldFlag);
  const defaultValue = resolveDefaultValue({
    flag: input.ldFlag,
    valueType,
  });

  const importedRules: GrowthBookRule[] = [];
  const warnings: RuleBuildWarning[] = [];
  const prerequisiteKeys = new Set<string>();
  const environments: Record<string, { enabled: boolean }> = {};

  for (const [environmentKey, envConfig] of Object.entries(
    input.ldFlag.environments ?? {},
  )) {
    environments[environmentKey] = {
      enabled: Boolean(envConfig.on),
    };

    const built = buildRulesFromLdEnvironment({
      ldProjectKey: input.ldProjectKey,
      ldFlag: input.ldFlag,
      environmentKey,
      envConfig,
      valueType,
      resolveSavedGroupId: input.resolveSavedGroupIdForEnv(environmentKey),
    });

    importedRules.push(...built.rules);
    warnings.push(...built.warnings);
    for (const key of built.prerequisiteKeys) {
      prerequisiteKeys.add(key);
    }
  }

  const createPayload: CreateFeaturePayload = {
    id: sanitizeFeatureId(input.ldFlag.key),
    owner: input.owner,
    description: input.ldFlag.description ?? input.ldFlag.name ?? "",
    project: input.gbProjectId,
    valueType,
    defaultValue,
    tags: input.ldFlag.tags,
    archived: Boolean(input.ldFlag.archived),
    rules: importedRules,
    environments,
    prerequisites:
      prerequisiteKeys.size > 0 ? [...prerequisiteKeys] : undefined,
  };

  return {
    createPayload,
    importedRules,
    warnings,
    valueType,
    defaultValue,
  };
}

export function planFeatureUpdate(input: {
  existingFeature: GrowthBookFeature;
  importedRules: GrowthBookRule[];
  environments: Record<string, { enabled: boolean }>;
  defaultValue: string;
  description?: string;
  prerequisites?: string[];
  archived?: boolean;
}): {
  body: {
    rules: GrowthBookRule[];
    environments: Record<string, { enabled: boolean }>;
    defaultValue: string;
    description?: string;
    prerequisites?: string[];
    archived?: boolean;
  };
  createdCount: number;
  replacedCount: number;
  changed: boolean;
} {
  const existingRules = Array.isArray(input.existingFeature.rules)
    ? input.existingFeature.rules
    : [];

  const merge = mergeImportedRules({
    existingRules,
    importedRules: input.importedRules,
  });

  const changed =
    merge.changed ||
    environmentsChanged(input.existingFeature, input.environments);

  return {
    body: {
      rules: merge.rules,
      environments: input.environments,
      defaultValue: input.defaultValue,
      description: input.description,
      prerequisites: input.prerequisites,
      archived: input.archived,
    },
    createdCount: merge.createdCount,
    replacedCount: merge.replacedCount,
    changed,
  };
}

function environmentsChanged(
  feature: GrowthBookFeature,
  next: Record<string, { enabled: boolean }>,
): boolean {
  const current = feature.environments ?? {};
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);

  if (currentKeys.length !== nextKeys.length) {
    return true;
  }

  for (const key of nextKeys) {
    if (Boolean(current[key]?.enabled) !== Boolean(next[key]?.enabled)) {
      return true;
    }
  }

  return false;
}

function sanitizeFeatureId(key: string): string {
  // GrowthBook: letters, numbers, hyphens, underscores
  return key.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function listVariationValues(
  variations: LaunchDarklyVariation[] | undefined,
): unknown[] {
  return (variations ?? []).map((variation) => variation.value);
}
