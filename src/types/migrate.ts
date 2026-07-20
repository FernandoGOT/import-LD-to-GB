import type {
  GrowthBookFeature,
  GrowthBookRule,
  LaunchDarklyFlag,
  LaunchDarklyProject,
  LaunchDarklyVariation,
} from "../variation-dedupe.js";

export type {
  GrowthBookFeature,
  GrowthBookRule,
  LaunchDarklyFlag,
  LaunchDarklyProject,
  LaunchDarklyVariation,
};

export type GrowthBookProject = {
  id: string;
  name: string;
  publicId?: string;
  description?: string;
};

export type GrowthBookEnvironment = {
  id: string;
  description?: string;
  toggleOnList?: boolean;
  defaultState?: boolean;
  projects?: string[];
  parent?: string;
};

export type GrowthBookSavedGroup = {
  id: string;
  name: string;
  type?: "condition" | "list";
  condition?: string;
  attributeKey?: string;
  values?: string[];
  projects?: string[];
  archived?: boolean;
};

export type LaunchDarklyEnvironment = {
  _id?: string;
  id?: string;
  key: string;
  name: string;
  color?: string;
  critical?: boolean;
};

export type LaunchDarklyClause = {
  _id?: string;
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
  contextKind?: string;
};

export type LaunchDarklyRolloutVariation = {
  variation: number;
  weight: number;
};

export type LaunchDarklyRollout = {
  variations: LaunchDarklyRolloutVariation[];
  contextKind?: string;
  bucketBy?: string;
};

export type LaunchDarklyTarget = {
  variation: number;
  values: string[];
  contextKind?: string;
};

export type LaunchDarklyRule = {
  _id?: string;
  id?: string;
  description?: string;
  clauses: LaunchDarklyClause[];
  variation?: number;
  rollout?: LaunchDarklyRollout;
  trackEvents?: boolean;
};

export type LaunchDarklyPrerequisite = {
  key: string;
  variation: number;
};

export type LaunchDarklyEnvConfig = {
  on?: boolean;
  targets?: LaunchDarklyTarget[];
  contextTargets?: LaunchDarklyTarget[];
  rules?: LaunchDarklyRule[];
  fallthrough?: {
    variation?: number;
    rollout?: LaunchDarklyRollout;
  };
  offVariation?: number;
  prerequisites?: LaunchDarklyPrerequisite[];
  _environmentName?: string;
};

export type LaunchDarklyFlagDetail = LaunchDarklyFlag & {
  description?: string;
  tags?: string[];
  temporary?: boolean;
  archived?: boolean;
  environments?: Record<string, LaunchDarklyEnvConfig>;
  defaults?: {
    onVariation?: number;
    offVariation?: number;
  };
};

export type LaunchDarklySegmentRule = {
  _id?: string;
  clauses: LaunchDarklyClause[];
  weight?: number;
  description?: string;
};

export type LaunchDarklySegment = {
  _id?: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  included?: string[];
  excluded?: string[];
  includedContexts?: Array<{
    values?: string[];
    contextKind?: string;
  }>;
  excludedContexts?: Array<{
    values?: string[];
    contextKind?: string;
  }>;
  rules?: LaunchDarklySegmentRule[];
  unbounded?: boolean;
  unboundedContextKind?: string;
  generation?: number;
};

export type ClauseMapResult = {
  condition?: Record<string, unknown>;
  savedGroupTargeting?: Array<{
    matchType: "all" | "any" | "none";
    savedGroups: string[];
  }>;
  unsupported: string[];
};

export type RuleBuildWarning = {
  kind: "unsupported_operator" | "unsupported_segment" | "missing_variation";
  details: string;
};

export type CreateFeaturePayload = {
  id: string;
  owner: string;
  description?: string;
  project?: string;
  valueType: string;
  defaultValue: string;
  tags?: string[];
  archived?: boolean;
  rules: GrowthBookRule[];
  environments: Record<string, { enabled: boolean }>;
  prerequisites?: string[];
};

export type SavedGroupCreatePayload = {
  name: string;
  type: "condition" | "list";
  condition?: string;
  attributeKey?: string;
  values?: string[];
  projects?: string[];
};
