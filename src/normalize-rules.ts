import { randomUUID } from "node:crypto";
import {
  type GrowthBookRule,
  removeUndefinedFields,
  serializeGrowthBookValue,
  stableStringify,
} from "./variation-dedupe.js";

export function normalizeRulesForGrowthBookApi(
  rules: GrowthBookRule[],
  valueType: string | undefined,
): GrowthBookRule[] {
  return rules.map((rule) => normalizeRuleForGrowthBookApi(rule, valueType));
}

export function normalizeRuleForGrowthBookApi(
  rule: GrowthBookRule,
  valueType: string | undefined,
): GrowthBookRule {
  const normalized: GrowthBookRule = {
    ...rule,
    id: typeof rule.id === "string" && rule.id ? rule.id : `rule-${randomUUID()}`,
    description: typeof rule.description === "string" ? rule.description : "",
    enabled: typeof rule.enabled === "boolean" ? rule.enabled : true,
    type: typeof rule.type === "string" ? rule.type : "force",
  };

  if (
    normalized.condition !== undefined &&
    typeof normalized.condition !== "string"
  ) {
    normalized.condition = stableStringify(normalized.condition);
  }

  if (!normalized.scheduleType) {
    normalized.scheduleType = "none";
  }

  if (normalized.allEnvironments === true) {
    normalized.allEnvironments = true;
    delete normalized.environments;
  } else if (Array.isArray(normalized.environments)) {
    normalized.allEnvironments = false;
    normalized.environments = [...normalized.environments];
  }

  if (
    normalized.type === "force" ||
    Object.prototype.hasOwnProperty.call(normalized, "value")
  ) {
    normalized.value = serializeGrowthBookValue(normalized.value, valueType);
  }

  if (normalized.type === "rollout" || normalized.type === "experiment") {
    if (Array.isArray(normalized.variations)) {
      normalized.variations = normalized.variations.map((item) => {
        if (!item || typeof item !== "object") {
          return item;
        }

        const record = item as Record<string, unknown>;
        return removeUndefinedFields({
          ...record,
          value: serializeGrowthBookValue(record.value, valueType),
        });
      });
    }
  }

  if (normalized.type === "experiment" && Array.isArray(normalized.value)) {
    normalized.value = normalized.value.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }

      const record = item as Record<string, unknown>;

      return removeUndefinedFields({
        ...record,
        value: serializeGrowthBookValue(record.value, valueType),
      });
    });
  }

  if (Object.prototype.hasOwnProperty.call(normalized, "controlValue")) {
    normalized.controlValue = serializeGrowthBookValue(
      normalized.controlValue,
      valueType,
    );
  }

  if (Object.prototype.hasOwnProperty.call(normalized, "variationValue")) {
    normalized.variationValue = serializeGrowthBookValue(
      normalized.variationValue,
      valueType,
    );
  }

  return removeUndefinedFields(normalized);
}
