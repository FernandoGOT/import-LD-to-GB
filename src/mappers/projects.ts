import type {
  GrowthBookProject,
  LaunchDarklyProject,
} from "../types/migrate.js";

export type ProjectMatchDecision =
  | { action: "matched"; gbProject: GrowthBookProject }
  | { action: "create"; publicId: string; name: string; description?: string }
  | { action: "unmatched" };

export function matchOrPlanCreateProject(input: {
  ldProject: LaunchDarklyProject;
  gbProjects: GrowthBookProject[];
  strategy: string;
  projectMap: Record<string, string>;
  allowCreate: boolean;
  /** Effective key/name after config.json remap (defaults to LD project). */
  effectiveKey?: string;
  effectiveName?: string;
}): ProjectMatchDecision {
  const { ldProject, gbProjects, strategy, projectMap, allowCreate } = input;
  const effectiveKey = input.effectiveKey ?? ldProject.key;
  const effectiveName = input.effectiveName ?? ldProject.name;

  if (strategy === "json") {
    const gbProjectId = projectMap[ldProject.key];
    if (!gbProjectId) {
      return allowCreate
        ? {
            action: "create",
            publicId: effectiveKey,
            name: effectiveName,
          }
        : { action: "unmatched" };
    }

    const gbProject = gbProjects.find((project) => project.id === gbProjectId);
    if (gbProject) {
      return { action: "matched", gbProject };
    }

    return allowCreate
      ? {
          action: "create",
          publicId: effectiveKey,
          name: effectiveName,
        }
      : { action: "unmatched" };
  }

  if (strategy !== "auto") {
    throw new Error(
      `PROJECT_MATCH_STRATEGY inválida: ${strategy}. Use "auto" ou "json".`,
    );
  }

  const byPublicId = gbProjects.find(
    (gbProject) => gbProject.publicId === effectiveKey,
  );
  if (byPublicId) {
    return { action: "matched", gbProject: byPublicId };
  }

  const byId = gbProjects.find((gbProject) => gbProject.id === effectiveKey);
  if (byId) {
    return { action: "matched", gbProject: byId };
  }

  const byName = gbProjects.find(
    (gbProject) =>
      normalizeName(gbProject.name) === normalizeName(effectiveName),
  );
  if (byName) {
    return { action: "matched", gbProject: byName };
  }

  if (allowCreate) {
    return {
      action: "create",
      publicId: effectiveKey,
      name: effectiveName,
    };
  }

  return { action: "unmatched" };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
