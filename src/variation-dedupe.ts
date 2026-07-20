import { createHash, randomUUID } from "node:crypto";

export type UnknownRecord = Record<string, unknown>;

export type LaunchDarklyProject = {
  id?: string;
  key: string;
  name: string;
};

export type LaunchDarklyVariation = {
  _id?: string;
  id?: string;
  key?: string;
  name?: string;
  description?: string;
  value: unknown;
};

export type LaunchDarklyFlag = {
  key: string;
  name?: string;
  kind?: string;
  variations?: LaunchDarklyVariation[];
};

export type GrowthBookRule = {
  id?: string;
  description?: string;
  condition?: string;
  enabled?: boolean;
  type?: string;
  value?: unknown;
  variations?: unknown[];
  weights?: number[];
  allEnvironments?: boolean;
  environments?: string[];
  [key: string]: unknown;
};

export type GrowthBookEnvironmentConfig = {
  enabled?: boolean;
  defaultValue?: unknown;
  rules?: GrowthBookRule[];
  definition?: string;
  draft?: {
    enabled?: boolean;
    defaultValue?: unknown;
    rules?: GrowthBookRule[];
    definition?: string;
  };
  [key: string]: unknown;
};

export type GrowthBookFeature = {
  id: string;
  archived?: boolean;
  description?: string;
  project?: string;
  valueType?: string;
  defaultValue?: unknown;
  rules?: GrowthBookRule[];
  environments?: Record<string, GrowthBookEnvironmentConfig>;
  [key: string]: unknown;
};

export type SyncRulesResult = {
  rules: GrowthBookRule[];
  createdCount: number;
  consolidatedCount: number;
  expandedCount: number;
  changed: boolean;
};

export function uniqueLdVariationsByValue(
  variations: LaunchDarklyVariation[],
  valueType: string | undefined,
): LaunchDarklyVariation[] {
  const seen = new Set<string>();
  const result: LaunchDarklyVariation[] = [];

  for (const variation of variations) {
    const key = canonicalValueKey(variation.value, valueType);
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(variation);
  }

  return result;
}

/** Prefer top-level v2 rules; fall back to flattening legacy per-env rules. */
export function getFeatureRules(feature: GrowthBookFeature): GrowthBookRule[] {
  if (Array.isArray(feature.rules)) {
    return feature.rules;
  }

  const flattened: GrowthBookRule[] = [];

  for (const env of Object.values(feature.environments ?? {})) {
    for (const rule of env.rules ?? []) {
      flattened.push(rule);
    }
  }

  return flattened;
}

export function collectExistingValueKeysForFeature(
  feature: GrowthBookFeature,
): Set<string> {
  const keys = new Set<string>();
  const valueType = feature.valueType;

  addValueKey(keys, feature.defaultValue, valueType);

  for (const env of Object.values(feature.environments ?? {})) {
    addValueKey(keys, env.defaultValue, valueType);
  }

  for (const rule of getFeatureRules(feature)) {
    addRuleValueKeys(keys, rule, valueType);
  }

  return keys;
}

/** @deprecated Prefer collectExistingValueKeysForFeature for multi-env rules. */
export function collectExistingValueKeysForEnvironment(
  feature: GrowthBookFeature,
  envKey: string,
): Set<string> {
  const keys = new Set<string>();
  const valueType = feature.valueType;

  addValueKey(keys, feature.defaultValue, valueType);

  const env = feature.environments?.[envKey];
  if (!env) return keys;

  addValueKey(keys, env.defaultValue, valueType);

  for (const rule of env.rules ?? []) {
    addRuleValueKeys(keys, rule, valueType);
  }

  return keys;
}

export function collectExistingRuleIds(
  rules: GrowthBookRule[] | GrowthBookEnvironmentConfig | undefined,
): Set<string> {
  const ids = new Set<string>();
  const list = Array.isArray(rules) ? rules : (rules?.rules ?? []);

  for (const rule of list) {
    if (typeof rule.id === "string" && rule.id) {
      ids.add(rule.id);
    }
  }

  return ids;
}

export function findMissingLdVariations(input: {
  ldVariations: LaunchDarklyVariation[];
  feature: GrowthBookFeature;
  ldProjectKey: string;
  flagKey: string;
  /** @deprecated Ignored — dedupe is feature-level across all environments. */
  envKey?: string;
}): LaunchDarklyVariation[] {
  const { ldVariations, feature, ldProjectKey, flagKey } = input;
  const existingValueKeys = collectExistingValueKeysForFeature(feature);
  const existingRuleIds = collectExistingRuleIds(getFeatureRules(feature));

  return ldVariations.filter((variation) => {
    const valueKey = canonicalValueKey(variation.value, feature.valueType);
    if (existingValueKeys.has(valueKey)) {
      return false;
    }

    const ruleId = buildRuleIdForVariation(ldProjectKey, flagKey, variation);
    if (existingRuleIds.has(ruleId)) {
      return false;
    }

    return true;
  });
}

export function buildDisabledGrowthBookRule(input: {
  ldProject: LaunchDarklyProject;
  ldFlag: LaunchDarklyFlag;
  gbFeature: GrowthBookFeature;
  variation: LaunchDarklyVariation;
  environments: string[];
}): GrowthBookRule {
  const { ldProject, ldFlag, gbFeature, variation, environments } = input;

  return removeUndefinedFields({
    id: buildRuleIdForVariation(ldProject.key, ldFlag.key, variation),
    description: variation.name,
    condition: "",
    enabled: false,
    scheduleType: "none",
    type: "force",
    value: serializeGrowthBookValue(variation.value, gbFeature.valueType),
    allEnvironments: false,
    environments: [...environments],
  });
}

export function mergeEnvironments(
  existing: string[] | undefined,
  target: string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const env of [...(existing ?? []), ...target]) {
    if (!env || seen.has(env)) continue;
    seen.add(env);
    result.push(env);
  }

  return result;
}

/**
 * Collapse legacy per-env copies (same import id or same force value) into one
 * rule spanning the union of environments, expand import rules to cover
 * targetEnvironments, then append truly new rules.
 */
export function syncFeatureRules(input: {
  existingRules: GrowthBookRule[];
  newRules: GrowthBookRule[];
  targetEnvironments: string[];
  valueType: string | undefined;
}): SyncRulesResult {
  const { existingRules, newRules, targetEnvironments, valueType } = input;

  let consolidatedCount = 0;
  let expandedCount = 0;
  let createdCount = 0;

  const byId = new Map<string, GrowthBookRule>();
  const importForceByValue = new Map<string, GrowthBookRule>();
  const anyForceByValue = new Map<string, GrowthBookRule>();
  const preserved: GrowthBookRule[] = [];

  for (const rule of existingRules) {
    const id = typeof rule.id === "string" && rule.id ? rule.id : undefined;
    const valueKey = isForceLikeRule(rule)
      ? canonicalValueKey(rule.value, valueType)
      : undefined;

    if (id && byId.has(id)) {
      const keeper = byId.get(id)!;
      mergeRuleEnvironmentsInto(keeper, rule, []);
      consolidatedCount += 1;
      continue;
    }

    if (
      valueKey !== undefined &&
      isImportStyleForceRule(rule) &&
      importForceByValue.has(valueKey)
    ) {
      const keeper = importForceByValue.get(valueKey)!;
      mergeRuleEnvironmentsInto(keeper, rule, []);
      consolidatedCount += 1;
      continue;
    }

    const cloned: GrowthBookRule = { ...rule };
    if (Array.isArray(rule.environments)) {
      cloned.environments = [...rule.environments];
    }
    preserved.push(cloned);

    if (id) {
      byId.set(id, cloned);
    }

    if (valueKey !== undefined) {
      anyForceByValue.set(valueKey, cloned);
      if (isImportStyleForceRule(cloned)) {
        importForceByValue.set(valueKey, cloned);
      }
    }
  }

  // Ensure every imported ld-var force rule covers all target environments.
  if (targetEnvironments.length > 0) {
    for (const rule of preserved) {
      if (!isImportStyleForceRule(rule) || rule.allEnvironments === true) {
        continue;
      }

      const before = JSON.stringify(ruleEnvironmentsSnapshot(rule));
      rule.allEnvironments = false;
      rule.environments = mergeEnvironments(rule.environments, targetEnvironments);
      const after = JSON.stringify(ruleEnvironmentsSnapshot(rule));
      if (before !== after) {
        expandedCount += 1;
      }
    }
  }

  for (const rule of newRules) {
    const id = typeof rule.id === "string" && rule.id ? rule.id : undefined;
    const valueKey = isForceLikeRule(rule)
      ? canonicalValueKey(rule.value, valueType)
      : undefined;

    const existingById = id ? byId.get(id) : undefined;
    if (existingById) {
      const before = JSON.stringify(ruleEnvironmentsSnapshot(existingById));
      mergeRuleEnvironmentsInto(existingById, rule, targetEnvironments);
      const after = JSON.stringify(ruleEnvironmentsSnapshot(existingById));
      if (before !== after) {
        expandedCount += 1;
      }
      continue;
    }

    const existingImportByValue =
      valueKey !== undefined ? importForceByValue.get(valueKey) : undefined;
    if (existingImportByValue) {
      const before = JSON.stringify(ruleEnvironmentsSnapshot(existingImportByValue));
      mergeRuleEnvironmentsInto(
        existingImportByValue,
        rule,
        targetEnvironments,
      );
      const after = JSON.stringify(ruleEnvironmentsSnapshot(existingImportByValue));
      if (before !== after) {
        expandedCount += 1;
      }
      continue;
    }

    if (valueKey !== undefined && anyForceByValue.has(valueKey)) {
      // A force rule (manual or otherwise) already covers this value.
      continue;
    }

    const created: GrowthBookRule = {
      ...rule,
      allEnvironments: false,
      environments: mergeEnvironments(
        Array.isArray(rule.environments) ? rule.environments : [],
        targetEnvironments,
      ),
    };
    preserved.push(created);
    createdCount += 1;

    if (id) {
      byId.set(id, created);
    }

    if (valueKey !== undefined) {
      anyForceByValue.set(valueKey, created);
      if (isImportStyleForceRule(created)) {
        importForceByValue.set(valueKey, created);
      }
    }
  }

  const changed = createdCount > 0 || consolidatedCount > 0 || expandedCount > 0;

  return {
    rules: preserved,
    createdCount,
    consolidatedCount,
    expandedCount,
    changed,
  };
}

export function mergeRulesWithoutDuplicates(
  existingRules: GrowthBookRule[],
  newRules: GrowthBookRule[],
  valueType: string | undefined,
): GrowthBookRule[] {
  return syncFeatureRules({
    existingRules,
    newRules,
    targetEnvironments: [],
    valueType,
  }).rules;
}

export function canonicalValueKey(
  value: unknown,
  valueType: string | undefined,
): string {
  const normalized = normalizeValueForComparison(value, valueType);
  return stableStringify(normalized);
}

export function normalizeValueForComparison(
  value: unknown,
  valueType: string | undefined,
): unknown {
  if (valueType === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }

  if (valueType === "number") {
    if (typeof value === "string" && value.trim() !== "") {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) return numberValue;
    }
  }

  if (valueType === "json") {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function serializeGrowthBookValue(
  value: unknown,
  valueType: string | undefined,
): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return inferFallbackDefaultValue(valueType);
  }

  if (valueType === "json") {
    return stableStringify(value);
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  return stableStringify(value);
}

export function inferFallbackDefaultValue(valueType: string | undefined): string {
  switch (valueType) {
    case "boolean":
      return "false";
    case "number":
      return "0";
    case "json":
      return "null";
    case "string":
    default:
      return "";
  }
}

export function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 16);
}

export function buildRuleId(
  ldProjectKey: string,
  flagKey: string,
  variationIdentity: string,
): string {
  const readable = slugify(
    `ld-var-${ldProjectKey}-${flagKey}-${variationIdentity}`,
  ).slice(0, 80);

  const hash = createHash("sha256")
    .update(`${ldProjectKey}:${flagKey}:${variationIdentity}`)
    .digest("hex")
    .slice(0, 10);

  return `${readable}-${hash}`;
}

export function buildRuleIdForVariation(
  ldProjectKey: string,
  flagKey: string,
  variation: LaunchDarklyVariation,
): string {
  const variationIdentity =
    variation.key ?? variation._id ?? variation.id ?? hashValue(variation.value);

  return buildRuleId(ldProjectKey, flagKey, variationIdentity);
}

export function removeUndefinedFields<T extends Record<string, unknown>>(
  obj: T,
): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;
}

export function previewValue(value: unknown): string {
  const text = stableStringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function mergeRuleEnvironmentsInto(
  keeper: GrowthBookRule,
  other: GrowthBookRule,
  targetEnvironments: string[],
) {
  if (keeper.allEnvironments === true || other.allEnvironments === true) {
    keeper.allEnvironments = true;
    keeper.environments = undefined;
    return;
  }

  keeper.allEnvironments = false;
  keeper.environments = mergeEnvironments(
    [
      ...(Array.isArray(keeper.environments) ? keeper.environments : []),
      ...(Array.isArray(other.environments) ? other.environments : []),
    ],
    targetEnvironments,
  );
}

function ruleEnvironmentsSnapshot(rule: GrowthBookRule): {
  allEnvironments?: boolean;
  environments?: string[];
} {
  return {
    allEnvironments: rule.allEnvironments === true ? true : undefined,
    environments: Array.isArray(rule.environments)
      ? [...rule.environments].sort()
      : undefined,
  };
}

function isImportStyleForceRule(rule: GrowthBookRule): boolean {
  return (
    isForceLikeRule(rule) &&
    typeof rule.id === "string" &&
    rule.id.startsWith("ld-var-")
  );
}

function addValueKey(
  set: Set<string>,
  value: unknown,
  valueType: string | undefined,
) {
  set.add(canonicalValueKey(value, valueType));
}

function addRuleValueKeys(
  keys: Set<string>,
  rule: GrowthBookRule,
  valueType: string | undefined,
) {
  if (rule.type === "experiment" && Array.isArray(rule.value)) {
    for (const item of rule.value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as UnknownRecord;
        if (Object.prototype.hasOwnProperty.call(record, "value")) {
          addValueKey(keys, record.value, valueType);
        }
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(rule, "value")) {
    addValueKey(keys, rule.value, valueType);
  }

  if (Array.isArray(rule.variations)) {
    for (const variationValue of rule.variations) {
      addValueKey(keys, variationValue, valueType);
    }
  }

  if (Object.prototype.hasOwnProperty.call(rule, "controlValue")) {
    addValueKey(keys, rule.controlValue, valueType);
  }

  if (Object.prototype.hasOwnProperty.call(rule, "variationValue")) {
    addValueKey(keys, rule.variationValue, valueType);
  }
}

function isForceLikeRule(rule: GrowthBookRule): boolean {
  if (rule.type === "experiment") {
    return false;
  }

  return (
    rule.type === "force" || Object.prototype.hasOwnProperty.call(rule, "value")
  );
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    const record = value as UnknownRecord;
    return Object.keys(record)
      .sort()
      .reduce<UnknownRecord>((acc, key) => {
        acc[key] = sortJson(record[key]);
        return acc;
      }, {});
  }

  return value;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || `ld-var-${randomUUID()}`;
}
