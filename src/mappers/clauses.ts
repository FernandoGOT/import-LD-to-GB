import type {
  ClauseMapResult,
  LaunchDarklyClause,
} from "../types/migrate.js";

export type SegmentIdResolver = (
  segmentKey: string,
) => string | undefined;

export function mapClausesToGrowthBook(input: {
  clauses: LaunchDarklyClause[];
  resolveSavedGroupId?: SegmentIdResolver;
}): ClauseMapResult {
  const unsupported: string[] = [];
  const andParts: Record<string, unknown>[] = [];
  const savedGroupsAll: string[] = [];
  const savedGroupsNone: string[] = [];

  for (const clause of input.clauses) {
    if (clause.op === "segmentMatch") {
      const segmentKeys = clause.values.map(String);
      for (const segmentKey of segmentKeys) {
        const savedGroupId = input.resolveSavedGroupId?.(segmentKey);
        if (!savedGroupId) {
          unsupported.push(`segmentMatch:${segmentKey}`);
          continue;
        }

        if (clause.negate) {
          savedGroupsNone.push(savedGroupId);
        } else {
          savedGroupsAll.push(savedGroupId);
        }
      }
      continue;
    }

    const mapped = mapSingleClause(clause);
    if (mapped.unsupported) {
      unsupported.push(mapped.unsupported);
      continue;
    }

    if (mapped.condition) {
      andParts.push(mapped.condition);
    }
  }

  const savedGroupTargeting: ClauseMapResult["savedGroupTargeting"] = [];
  if (savedGroupsAll.length > 0) {
    savedGroupTargeting.push({
      matchType: "all",
      savedGroups: savedGroupsAll,
    });
  }
  if (savedGroupsNone.length > 0) {
    savedGroupTargeting.push({
      matchType: "none",
      savedGroups: savedGroupsNone,
    });
  }

  let condition: Record<string, unknown> | undefined;
  if (andParts.length === 1) {
    condition = andParts[0];
  } else if (andParts.length > 1) {
    condition = { $and: andParts };
  }

  return {
    condition,
    savedGroupTargeting:
      savedGroupTargeting.length > 0 ? savedGroupTargeting : undefined,
    unsupported,
  };
}

function mapSingleClause(clause: LaunchDarklyClause): {
  condition?: Record<string, unknown>;
  unsupported?: string;
} {
  const attribute = attributeKeyForClause(clause);
  const values = clause.values;
  const op = clause.op;
  const negate = clause.negate;

  switch (op) {
    case "in": {
      if (values.length === 1) {
        const value = values[0];
        return {
          condition: negate
            ? { [attribute]: { $ne: value } }
            : { [attribute]: value },
        };
      }

      return {
        condition: {
          [attribute]: negate ? { $nin: values } : { $in: values },
        },
      };
    }

    case "endsWith": {
      const patterns = values.map((value) => `${escapeRegex(String(value))}$`);
      return regexCondition(attribute, patterns, negate);
    }

    case "startsWith": {
      const patterns = values.map((value) => `^${escapeRegex(String(value))}`);
      return regexCondition(attribute, patterns, negate);
    }

    case "contains": {
      const patterns = values.map((value) => escapeRegex(String(value)));
      return regexCondition(attribute, patterns, negate);
    }

    case "matches": {
      const patterns = values.map(String);
      return regexCondition(attribute, patterns, negate, false);
    }

    case "semVerEqual":
      return semVerCondition(attribute, "$veq", values, negate);
    case "semVerNotEqual":
      return semVerCondition(attribute, "$vne", values, negate);
    case "semVerLessThan":
      return semVerCondition(attribute, "$vlt", values, negate);
    case "semVerLessThanOrEqual":
      return semVerCondition(attribute, "$vlte", values, negate);
    case "semVerGreaterThan":
      return semVerCondition(attribute, "$vgt", values, negate);
    case "semVerGreaterThanOrEqual":
      return semVerCondition(attribute, "$vgte", values, negate);

    case "before": {
      const timestamps = values.map(toComparableNumber);
      if (timestamps.some((value) => value == null)) {
        return { unsupported: `before:${attribute}` };
      }
      return comparisonCondition(attribute, "$lt", timestamps as number[], negate);
    }

    case "after": {
      const timestamps = values.map(toComparableNumber);
      if (timestamps.some((value) => value == null)) {
        return { unsupported: `after:${attribute}` };
      }
      return comparisonCondition(attribute, "$gt", timestamps as number[], negate);
    }

    default:
      return { unsupported: `${op}:${attribute}` };
  }
}

function attributeKeyForClause(clause: LaunchDarklyClause): string {
  const contextKind = clause.contextKind?.trim();
  if (!contextKind || contextKind === "user") {
    return clause.attribute;
  }

  // Align multi-context attributes with common SDK attribute naming.
  if (clause.attribute === "key") {
    return `${contextKind}Id`;
  }

  return `${contextKind}.${clause.attribute}`;
}

function regexCondition(
  attribute: string,
  patterns: string[],
  negate: boolean,
  escapeAlreadyApplied = true,
): { condition: Record<string, unknown> } {
  void escapeAlreadyApplied;
  const pattern =
    patterns.length === 1 ? patterns[0]! : `(?:${patterns.join("|")})`;

  const regexNode = { $regex: pattern };
  if (!negate) {
    return { condition: { [attribute]: regexNode } };
  }

  return {
    condition: {
      [attribute]: { $not: regexNode },
    },
  };
}

function semVerCondition(
  attribute: string,
  operator: string,
  values: unknown[],
  negate: boolean,
): { condition: Record<string, unknown> } {
  const version = String(values[0] ?? "");
  const node = { [operator]: version };

  if (!negate) {
    return { condition: { [attribute]: node } };
  }

  return {
    condition: {
      [attribute]: { $not: node },
    },
  };
}

function comparisonCondition(
  attribute: string,
  operator: "$lt" | "$gt",
  values: number[],
  negate: boolean,
): { condition: Record<string, unknown> } {
  const value = values[0]!;
  const inverted = operator === "$lt" ? "$gte" : "$lte";
  const node = { [negate ? inverted : operator]: value };
  return { condition: { [attribute]: node } };
}

function toComparableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }

    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) {
      return asDate;
    }
  }

  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
