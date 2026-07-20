import type {
  GrowthBookEnvironment,
  LaunchDarklyEnvironment,
} from "../types/migrate.js";

export type EnvironmentUpsertDecision =
  | { action: "matched"; gbEnvironment: GrowthBookEnvironment }
  | {
      action: "create";
      id: string;
      description: string;
      projects?: string[];
    };

export function planEnvironmentUpsert(input: {
  ldEnvironment: LaunchDarklyEnvironment;
  gbEnvironments: GrowthBookEnvironment[];
  gbProjectId?: string;
}): EnvironmentUpsertDecision {
  const { ldEnvironment, gbEnvironments, gbProjectId } = input;
  const existing = gbEnvironments.find((env) => env.id === ldEnvironment.key);

  if (existing) {
    return { action: "matched", gbEnvironment: existing };
  }

  return {
    action: "create",
    id: ldEnvironment.key,
    description: ldEnvironment.name,
    projects: gbProjectId ? [gbProjectId] : undefined,
  };
}

export function collectUniqueLdEnvironmentKeys(
  environmentsByProject: Map<string, LaunchDarklyEnvironment[]>,
): LaunchDarklyEnvironment[] {
  const byKey = new Map<string, LaunchDarklyEnvironment>();

  for (const envs of environmentsByProject.values()) {
    for (const env of envs) {
      if (!byKey.has(env.key)) {
        byKey.set(env.key, env);
      }
    }
  }

  return [...byKey.values()];
}
