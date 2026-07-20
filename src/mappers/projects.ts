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
}): ProjectMatchDecision {
  const { ldProject, gbProjects, strategy, projectMap, allowCreate } = input;

  if (strategy === "json") {
    const gbProjectId = projectMap[ldProject.key];
    if (!gbProjectId) {
      return allowCreate
        ? {
            action: "create",
            publicId: ldProject.key,
            name: ldProject.name,
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
          publicId: ldProject.key,
          name: ldProject.name,
        }
      : { action: "unmatched" };
  }

  if (strategy !== "auto") {
    throw new Error(
      `PROJECT_MATCH_STRATEGY inválida: ${strategy}. Use "auto" ou "json".`,
    );
  }

  const byPublicId = gbProjects.find(
    (gbProject) => gbProject.publicId === ldProject.key,
  );
  if (byPublicId) {
    return { action: "matched", gbProject: byPublicId };
  }

  const byId = gbProjects.find((gbProject) => gbProject.id === ldProject.key);
  if (byId) {
    return { action: "matched", gbProject: byId };
  }

  const byName = gbProjects.find(
    (gbProject) =>
      normalizeName(gbProject.name) === normalizeName(ldProject.name),
  );
  if (byName) {
    return { action: "matched", gbProject: byName };
  }

  if (allowCreate) {
    return {
      action: "create",
      publicId: ldProject.key,
      name: ldProject.name,
    };
  }

  return { action: "unmatched" };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
