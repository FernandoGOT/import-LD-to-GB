import type {
  GrowthBookEnvironment,
  LaunchDarklyEnvironment,
} from "../types/migrate.js";
import type { ImportConfig } from "../config.js";
import {
  getEnvironmentStrategy,
  isEnvironmentIgnored,
  resolveEffectiveEnvironmentTarget,
} from "../config.js";

export type EnvironmentUpsertDecision =
  | { action: "matched"; gbEnvironment: GrowthBookEnvironment }
  | {
      action: "create";
      id: string;
      description: string;
      projects?: string[];
      ldProjectKey?: string;
      ldEnvironmentKey: string;
      strategy: "shared" | "unique";
    };

export function planEnvironmentUpsert(input: {
  ldEnvironment: LaunchDarklyEnvironment;
  gbEnvironments: GrowthBookEnvironment[];
  gbProjectId?: string;
  /** Effective GB id/description after config remap. */
  effectiveId?: string;
  effectiveDescription?: string;
  strategy?: "shared" | "unique";
  ldProjectKey?: string;
}): EnvironmentUpsertDecision {
  const { ldEnvironment, gbEnvironments, gbProjectId } = input;
  const id = input.effectiveId ?? ldEnvironment.key;
  const description = input.effectiveDescription ?? ldEnvironment.name;
  const strategy = input.strategy ?? "shared";
  const existing = gbEnvironments.find((env) => env.id === id);

  if (existing) {
    return { action: "matched", gbEnvironment: existing };
  }

  return {
    action: "create",
    id,
    description,
    projects:
      strategy === "unique" && gbProjectId
        ? [gbProjectId]
        : undefined,
    ldProjectKey: input.ldProjectKey,
    ldEnvironmentKey: ldEnvironment.key,
    strategy,
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

export type PlannedEnvironment = {
  ldProjectKey: string;
  ldEnvironment: LaunchDarklyEnvironment;
  effectiveId: string;
  effectiveDescription: string;
  strategy: "shared" | "unique";
};

/**
 * Build the list of environments to upsert for migrate, respecting
 * shared (deduped) vs unique (per-project) strategies from config.
 */
export function planEnvironmentsForProjects(input: {
  config: ImportConfig;
  ldEnvsByProject: Map<string, LaunchDarklyEnvironment[]>;
  activeProjectKeys: string[];
}): PlannedEnvironment[] {
  const { config, ldEnvsByProject, activeProjectKeys } = input;
  const planned: PlannedEnvironment[] = [];
  const sharedSeen = new Set<string>();

  for (const ldProjectKey of activeProjectKeys) {
    const strategy = getEnvironmentStrategy(config, ldProjectKey);
    const envs = ldEnvsByProject.get(ldProjectKey) ?? [];

    for (const ldEnvironment of envs) {
      if (isEnvironmentIgnored(config, ldProjectKey, ldEnvironment.key)) {
        continue;
      }

      const target = resolveEffectiveEnvironmentTarget(
        config,
        ldProjectKey,
        ldEnvironment,
      );

      if (strategy === "shared") {
        if (sharedSeen.has(target.key)) continue;
        sharedSeen.add(target.key);
      }

      planned.push({
        ldProjectKey,
        ldEnvironment,
        effectiveId: target.key,
        effectiveDescription: target.name,
        strategy,
      });
    }
  }

  return planned;
}

export function rewriteEnvironmentKeys<T>(
  environments: Record<string, T> | undefined,
  envKeyMap: Map<string, string>,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [ldKey, value] of Object.entries(environments ?? {})) {
    if (!envKeyMap.has(ldKey)) continue;
    const effectiveKey = envKeyMap.get(ldKey)!;
    result[effectiveKey] = value;
  }
  return result;
}

export function mapEnvironmentKey(
  ldEnvKey: string,
  envKeyMap: Map<string, string> | undefined,
): string {
  return envKeyMap?.get(ldEnvKey) ?? ldEnvKey;
}
