import { createHash } from "node:crypto";
import { mapClausesToGrowthBook, type SegmentIdResolver } from "./clauses.js";
import {
  removeUndefinedFields,
  serializeGrowthBookValue,
  stableStringify,
  type GrowthBookRule,
  type LaunchDarklyVariation,
} from "../variation-dedupe.js";
import type {
  LaunchDarklyEnvConfig,
  LaunchDarklyFlagDetail,
  LaunchDarklyRollout,
  LaunchDarklyTarget,
  RuleBuildWarning,
} from "../types/migrate.js";

export type BuiltRulesResult = {
  rules: GrowthBookRule[];
  warnings: RuleBuildWarning[];
  prerequisiteKeys: string[];
};

export function buildRulesFromLdEnvironment(input: {
  ldProjectKey: string;
  ldFlag: LaunchDarklyFlagDetail;
  environmentKey: string;
  envConfig: LaunchDarklyEnvConfig;
  valueType: string | undefined;
  resolveSavedGroupId?: SegmentIdResolver;
}): BuiltRulesResult {
  const warnings: RuleBuildWarning[] = [];
  const rules: GrowthBookRule[] = [];
  const variations = input.ldFlag.variations ?? [];
  const prerequisiteKeys = (input.envConfig.prerequisites ?? []).map(
    (item) => item.key,
  );

  const targets = [
    ...(input.envConfig.targets ?? []),
    ...(input.envConfig.contextTargets ?? []),
  ];

  for (const [targetIndex, target] of targets.entries()) {
    const value = variationValue(variations, target.variation);
    if (value === undefined) {
      warnings.push({
        kind: "missing_variation",
        details: `target variation ${target.variation} missing on ${input.ldFlag.key}`,
      });
      continue;
    }

    const attribute = targetAttribute(target);
    const condition = {
      [attribute]:
        target.values.length === 1
          ? target.values[0]
          : { $in: target.values },
    };

    rules.push(
      removeUndefinedFields({
        id: buildRuleId(
          input.ldProjectKey,
          input.ldFlag.key,
          input.environmentKey,
          `target-${targetIndex}-${target.variation}`,
        ),
        description: `LD individual target (${attribute})`,
        condition: stableStringify(condition),
        enabled: false,
        scheduleType: "none",
        type: "force",
        value: serializeGrowthBookValue(value, input.valueType),
        allEnvironments: false,
        environments: [input.environmentKey],
      }),
    );
  }

  for (const [ruleIndex, ldRule] of (input.envConfig.rules ?? []).entries()) {
    const mapped = mapClausesToGrowthBook({
      clauses: ldRule.clauses ?? [],
      resolveSavedGroupId: input.resolveSavedGroupId,
    });

    for (const unsupported of mapped.unsupported) {
      warnings.push({
        kind: unsupported.startsWith("segmentMatch:")
          ? "unsupported_segment"
          : "unsupported_operator",
        details: `${input.ldFlag.key}/${input.environmentKey}: ${unsupported}`,
      });
    }

    const ruleId = buildRuleId(
      input.ldProjectKey,
      input.ldFlag.key,
      input.environmentKey,
      ldRule._id ?? ldRule.id ?? `rule-${ruleIndex}`,
    );

    if (ldRule.rollout) {
      const rolloutRule = buildRolloutRule({
        id: ruleId,
        description: ldRule.description ?? "LD targeting rollout",
        condition: mapped.condition,
        savedGroupTargeting: mapped.savedGroupTargeting,
        rollout: ldRule.rollout,
        variations,
        valueType: input.valueType,
        environmentKey: input.environmentKey,
        warnings,
        flagKey: input.ldFlag.key,
      });
      if (rolloutRule) {
        rules.push(rolloutRule);
      }
      continue;
    }

    if (typeof ldRule.variation === "number") {
      const value = variationValue(variations, ldRule.variation);
      if (value === undefined) {
        warnings.push({
          kind: "missing_variation",
          details: `rule variation ${ldRule.variation} missing on ${input.ldFlag.key}`,
        });
        continue;
      }

      rules.push(
        removeUndefinedFields({
          id: ruleId,
          description: ldRule.description ?? "LD targeting rule",
          condition: mapped.condition
            ? stableStringify(mapped.condition)
            : "",
          savedGroupTargeting: mapped.savedGroupTargeting,
          enabled: false,
          scheduleType: "none",
          type: "force",
          value: serializeGrowthBookValue(value, input.valueType),
          allEnvironments: false,
          environments: [input.environmentKey],
        }),
      );
    }
  }

  const fallthrough = input.envConfig.fallthrough;
  if (fallthrough?.rollout) {
    const rolloutRule = buildRolloutRule({
      id: buildRuleId(
        input.ldProjectKey,
        input.ldFlag.key,
        input.environmentKey,
        "fallthrough-rollout",
      ),
      description: "LD fallthrough rollout",
      condition: undefined,
      savedGroupTargeting: undefined,
      rollout: fallthrough.rollout,
      variations,
      valueType: input.valueType,
      environmentKey: input.environmentKey,
      warnings,
      flagKey: input.ldFlag.key,
    });
    if (rolloutRule) {
      rules.push(rolloutRule);
    }
  } else if (typeof fallthrough?.variation === "number") {
    const value = variationValue(variations, fallthrough.variation);
    if (value === undefined) {
      warnings.push({
        kind: "missing_variation",
        details: `fallthrough variation ${fallthrough.variation} missing on ${input.ldFlag.key}`,
      });
    } else {
      rules.push(
        removeUndefinedFields({
          id: buildRuleId(
            input.ldProjectKey,
            input.ldFlag.key,
            input.environmentKey,
            "fallthrough",
          ),
          description: "LD fallthrough",
          condition: "",
          enabled: false,
          scheduleType: "none",
          type: "force",
          value: serializeGrowthBookValue(value, input.valueType),
          allEnvironments: false,
          environments: [input.environmentKey],
        }),
      );
    }
  }

  return { rules, warnings, prerequisiteKeys };
}

export function mergeImportedRules(input: {
  existingRules: GrowthBookRule[];
  importedRules: GrowthBookRule[];
}): {
  rules: GrowthBookRule[];
  createdCount: number;
  replacedCount: number;
  changed: boolean;
} {
  const byId = new Map<string, GrowthBookRule>();
  for (const rule of input.existingRules) {
    if (typeof rule.id === "string" && rule.id) {
      byId.set(rule.id, rule);
    }
  }

  let createdCount = 0;
  let replacedCount = 0;

  for (const imported of input.importedRules) {
    const id = typeof imported.id === "string" ? imported.id : undefined;
    if (!id) continue;

    if (byId.has(id)) {
      byId.set(id, imported);
      replacedCount += 1;
    } else {
      byId.set(id, imported);
      createdCount += 1;
    }
  }

  const merged: GrowthBookRule[] = [];
  const seen = new Set<string>();

  for (const rule of input.existingRules) {
    const id = typeof rule.id === "string" ? rule.id : undefined;
    if (id && byId.has(id)) {
      if (!seen.has(id)) {
        merged.push(byId.get(id)!);
        seen.add(id);
      }
      continue;
    }

    if (!id) {
      merged.push(rule);
    }
  }

  for (const [id, rule] of byId.entries()) {
    if (!seen.has(id)) {
      merged.push(rule);
      seen.add(id);
    }
  }

  const changed = createdCount > 0 || replacedCount > 0;

  return {
    rules: merged,
    createdCount,
    replacedCount,
    changed,
  };
}

function buildRolloutRule(input: {
  id: string;
  description: string;
  condition: Record<string, unknown> | undefined;
  savedGroupTargeting:
    | Array<{
        matchType: "all" | "any" | "none";
        savedGroups: string[];
      }>
    | undefined;
  rollout: LaunchDarklyRollout;
  variations: LaunchDarklyVariation[];
  valueType: string | undefined;
  environmentKey: string;
  warnings: RuleBuildWarning[];
  flagKey: string;
}): GrowthBookRule | undefined {
  const weights: number[] = [];
  const gbVariations: Array<{ value: string; weight?: number }> = [];

  for (const entry of input.rollout.variations ?? []) {
    const value = variationValue(input.variations, entry.variation);
    if (value === undefined) {
      input.warnings.push({
        kind: "missing_variation",
        details: `rollout variation ${entry.variation} missing on ${input.flagKey}`,
      });
      continue;
    }

    const weight = (entry.weight ?? 0) / 100000;
    weights.push(weight);
    gbVariations.push({
      value: serializeGrowthBookValue(value, input.valueType),
      weight,
    });
  }

  if (gbVariations.length === 0) {
    return undefined;
  }

  // GrowthBook rollout often uses coverage + variations; keep weights on both.
  const coverage = weights.reduce((sum, weight) => sum + weight, 0);

  return removeUndefinedFields({
    id: input.id,
    description: input.description,
    condition: input.condition ? stableStringify(input.condition) : "",
    savedGroupTargeting: input.savedGroupTargeting,
    enabled: false,
    scheduleType: "none",
    type: "rollout",
    value:
      gbVariations.find((item) => (item.weight ?? 0) > 0)?.value ??
      gbVariations[0]!.value,
    variations: gbVariations,
    weights,
    coverage: coverage > 0 ? Math.min(coverage, 1) : 1,
    hashAttribute: input.rollout.bucketBy ?? "id",
    allEnvironments: false,
    environments: [input.environmentKey],
  });
}

function variationValue(
  variations: LaunchDarklyVariation[],
  index: number,
): unknown {
  return variations[index]?.value;
}

function targetAttribute(target: LaunchDarklyTarget): string {
  const contextKind = target.contextKind?.trim();
  if (!contextKind || contextKind === "user") {
    return "id";
  }

  return `${contextKind}Id`;
}

export function buildRuleId(
  projectKey: string,
  flagKey: string,
  environmentKey: string,
  identity: string,
): string {
  const raw = `${projectKey}|${flagKey}|${environmentKey}|${identity}`;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 10);
  const safe = identity
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return `ld-rule-${safe || "x"}-${hash}`;
}
