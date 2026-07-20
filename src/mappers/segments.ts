import { mapClausesToGrowthBook } from "./clauses.js";
import { stableStringify } from "../variation-dedupe.js";
import type {
  GrowthBookSavedGroup,
  LaunchDarklySegment,
  SavedGroupCreatePayload,
} from "../types/migrate.js";

export type SegmentUpsertDecision =
  | {
      action: "unsupported";
      reason: string;
      savedGroupName: string;
    }
  | {
      action: "matched";
      gbSavedGroup: GrowthBookSavedGroup;
      savedGroupName: string;
    }
  | {
      action: "create";
      payload: SavedGroupCreatePayload;
      savedGroupName: string;
    };

export function buildSavedGroupName(input: {
  ldProjectKey: string;
  environmentKey: string;
  segmentKey: string;
}): string {
  return `${input.ldProjectKey}:${input.environmentKey}:${input.segmentKey}`;
}

export function planSegmentUpsert(input: {
  ldProjectKey: string;
  environmentKey: string;
  segment: LaunchDarklySegment;
  existingSavedGroups: GrowthBookSavedGroup[];
  gbProjectId?: string;
  listAttributeKey: string;
}): SegmentUpsertDecision {
  const savedGroupName = buildSavedGroupName({
    ldProjectKey: input.ldProjectKey,
    environmentKey: input.environmentKey,
    segmentKey: input.segment.key,
  });

  if (input.segment.unbounded) {
    return {
      action: "unsupported",
      reason: "big/unbounded segment",
      savedGroupName,
    };
  }

  const existing = input.existingSavedGroups.find(
    (group) => group.name === savedGroupName,
  );
  if (existing) {
    return {
      action: "matched",
      gbSavedGroup: existing,
      savedGroupName,
    };
  }

  const includedValues = collectIncludedValues(input.segment);
  const hasRules = (input.segment.rules?.length ?? 0) > 0;
  const hasExcluded =
    (input.segment.excluded?.length ?? 0) > 0 ||
    (input.segment.excludedContexts?.length ?? 0) > 0;

  if (hasRules) {
    const clauses = (input.segment.rules ?? []).flatMap(
      (rule) => rule.clauses ?? [],
    );
    const mapped = mapClausesToGrowthBook({ clauses });

    if (mapped.unsupported.length > 0 && !mapped.condition) {
      return {
        action: "unsupported",
        reason: `unsupported operators: ${mapped.unsupported.join(", ")}`,
        savedGroupName,
      };
    }

    if (!mapped.condition) {
      return {
        action: "unsupported",
        reason: "segment rules produced empty condition",
        savedGroupName,
      };
    }

    // Exclusions and included lists on rule-based segments are approximated
    // by ANDing not-in / in when present.
    const conditionParts: Record<string, unknown>[] = [mapped.condition];

    if (includedValues.length > 0) {
      conditionParts.push({
        [input.listAttributeKey]: { $in: includedValues },
      });
    }

    const excludedValues = collectExcludedValues(input.segment);
    if (excludedValues.length > 0) {
      conditionParts.push({
        [input.listAttributeKey]: { $nin: excludedValues },
      });
    }

    const condition =
      conditionParts.length === 1
        ? conditionParts[0]!
        : { $and: conditionParts };

    return {
      action: "create",
      savedGroupName,
      payload: {
        name: savedGroupName,
        type: "condition",
        condition: stableStringify(condition),
        projects: input.gbProjectId ? [input.gbProjectId] : undefined,
      },
    };
  }

  if (includedValues.length > 0 && !hasExcluded) {
    return {
      action: "create",
      savedGroupName,
      payload: {
        name: savedGroupName,
        type: "list",
        attributeKey: input.listAttributeKey,
        values: includedValues,
        projects: input.gbProjectId ? [input.gbProjectId] : undefined,
      },
    };
  }

  if (includedValues.length > 0 || hasExcluded) {
    const excludedValues = collectExcludedValues(input.segment);
    const parts: Record<string, unknown>[] = [];

    if (includedValues.length > 0) {
      parts.push({ [input.listAttributeKey]: { $in: includedValues } });
    }
    if (excludedValues.length > 0) {
      parts.push({ [input.listAttributeKey]: { $nin: excludedValues } });
    }

    const condition = parts.length === 1 ? parts[0]! : { $and: parts };

    return {
      action: "create",
      savedGroupName,
      payload: {
        name: savedGroupName,
        type: "condition",
        condition: stableStringify(condition),
        projects: input.gbProjectId ? [input.gbProjectId] : undefined,
      },
    };
  }

  return {
    action: "unsupported",
    reason: "empty segment (no included keys or rules)",
    savedGroupName,
  };
}

function collectIncludedValues(segment: LaunchDarklySegment): string[] {
  const values = new Set<string>();

  for (const value of segment.included ?? []) {
    values.add(String(value));
  }

  for (const context of segment.includedContexts ?? []) {
    for (const value of context.values ?? []) {
      values.add(String(value));
    }
  }

  return [...values];
}

function collectExcludedValues(segment: LaunchDarklySegment): string[] {
  const values = new Set<string>();

  for (const value of segment.excluded ?? []) {
    values.add(String(value));
  }

  for (const context of segment.excludedContexts ?? []) {
    for (const value of context.values ?? []) {
      values.add(String(value));
    }
  }

  return [...values];
}
