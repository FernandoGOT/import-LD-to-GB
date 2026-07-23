import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { createGbClient } from "./api/gb-client.js";
import { createLdClient } from "./api/ld-client.js";
import {
  delay,
  deriveFeaturesApiBaseUrl,
  parseBoolean,
  parseProjectMap,
  requiredEnv,
} from "./api/http.js";
import {
  assertNoEnvironmentConflicts,
  buildEffectiveEnvKeyMap,
  defaultConfigPath,
  filterAndRemapVariations,
  isFlagIgnored,
  isProjectIgnored,
  loadImportConfig,
  remapFlag,
  remapProject,
  summarizeImportConfig,
  type ImportConfig,
} from "./config.js";
import {
  planEnvironmentUpsert,
  planEnvironmentsForProjects,
} from "./mappers/environments.js";
import {
  buildFeatureFromLdFlag,
  planFeatureUpdate,
} from "./mappers/features.js";
import { matchOrPlanCreateProject } from "./mappers/projects.js";
import { planSegmentUpsert } from "./mappers/segments.js";
import { normalizeRulesForGrowthBookApi } from "./normalize-rules.js";
import type {
  GrowthBookFeature,
  GrowthBookProject,
  GrowthBookSavedGroup,
  LaunchDarklyEnvironment,
  LaunchDarklyFlagDetail,
  LaunchDarklyProject,
} from "./types/migrate.js";
import {
  buildDisabledGrowthBookRule,
  findMissingLdVariations,
  getFeatureRules,
  hashValue,
  previewValue,
  syncFeatureRules,
  uniqueLdVariationsByValue,
} from "./variation-dedupe.js";

type MigrateReport = {
  startedAt: string;
  finishedAt?: string;
  dryRun: boolean;
  config: Record<string, unknown>;
  totals: {
    ldProjects: number;
    ldEnvironments: number;
    ldFlags: number;
    ldSegments: number;
    gbProjects: number;
    gbEnvironments: number;
    gbFeatures: number;
    gbSavedGroups: number;
    createdProjects: number;
    matchedProjects: number;
    createdEnvironments: number;
    matchedEnvironments: number;
    createdSavedGroups: number;
    matchedSavedGroups: number;
    unsupportedSegments: number;
    createdFeatures: number;
    updatedFeatures: number;
    importedTargetingRules: number;
    createdVariationRules: number;
    unsupportedOperators: number;
    errors: number;
  };
  actions: Array<Record<string, unknown>>;
};

const LD_API_BASE_URL =
  process.env.LD_API_BASE_URL ?? "https://app.launchdarkly.com/api/v2";
const LD_API_TOKEN = requiredEnv("LD_API_TOKEN");
const LD_API_VERSION = process.env.LD_API_VERSION ?? "20240415";

const GB_API_BASE_URL =
  process.env.GB_API_BASE_URL ?? "https://api.growthbook.io/api/v1";
const GB_FEATURES_API_BASE_URL =
  process.env.GB_FEATURES_API_BASE_URL?.trim() ||
  deriveFeaturesApiBaseUrl(GB_API_BASE_URL);
const GB_API_KEY = requiredEnv("GB_API_KEY");

const DRY_RUN = parseBoolean(process.env.DRY_RUN, true);
const PROJECT_MATCH_STRATEGY =
  process.env.PROJECT_MATCH_STRATEGY?.trim() || "auto";
const PROJECT_MAP_JSON = parseProjectMap(process.env.PROJECT_MAP_JSON);

const MIGRATE_CREATE_PROJECTS = parseBoolean(
  process.env.MIGRATE_CREATE_PROJECTS,
  true,
);
const MIGRATE_CREATE_ENVIRONMENTS = parseBoolean(
  process.env.MIGRATE_CREATE_ENVIRONMENTS,
  true,
);
const MIGRATE_CREATE_FEATURES = parseBoolean(
  process.env.MIGRATE_CREATE_FEATURES,
  true,
);
const MIGRATE_CREATE_SAVED_GROUPS = parseBoolean(
  process.env.MIGRATE_CREATE_SAVED_GROUPS,
  true,
);
const MIGRATE_IMPORT_TARGETING = parseBoolean(
  process.env.MIGRATE_IMPORT_TARGETING,
  true,
);
const MIGRATE_IMPORT_VARIATIONS = parseBoolean(
  process.env.MIGRATE_IMPORT_VARIATIONS,
  true,
);
const SEGMENT_LIST_ATTRIBUTE_KEY =
  process.env.SEGMENT_LIST_ATTRIBUTE_KEY?.trim() || "id";
// Self-hosted GrowthBook requires owner on POST /features.
const GB_FEATURE_OWNER =
  process.env.GB_FEATURE_OWNER?.trim() || "ld-migrate";

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? "250");
const REPORT_PATH =
  process.env.REPORT_PATH ?? "./ld-growthbook-migrate-report.json";
const CONFIG_PATH = defaultConfigPath();

async function main() {
  console.log(`Carregando e validando config: ${CONFIG_PATH}`);
  const importConfig = await loadImportConfig(CONFIG_PATH);

  const report: MigrateReport = {
    startedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    config: {
      configPath: CONFIG_PATH,
      importConfig: summarizeImportConfig(importConfig),
      projectMatchStrategy: PROJECT_MATCH_STRATEGY,
      migrateCreateProjects: MIGRATE_CREATE_PROJECTS,
      migrateCreateEnvironments: MIGRATE_CREATE_ENVIRONMENTS,
      migrateCreateFeatures: MIGRATE_CREATE_FEATURES,
      migrateCreateSavedGroups: MIGRATE_CREATE_SAVED_GROUPS,
      migrateImportTargeting: MIGRATE_IMPORT_TARGETING,
      migrateImportVariations: MIGRATE_IMPORT_VARIATIONS,
      segmentListAttributeKey: SEGMENT_LIST_ATTRIBUTE_KEY,
      gbFeatureOwner: GB_FEATURE_OWNER,
      gbApiBaseUrl: GB_API_BASE_URL,
      gbFeaturesApiBaseUrl: GB_FEATURES_API_BASE_URL,
    },
    totals: {
      ldProjects: 0,
      ldEnvironments: 0,
      ldFlags: 0,
      ldSegments: 0,
      gbProjects: 0,
      gbEnvironments: 0,
      gbFeatures: 0,
      gbSavedGroups: 0,
      createdProjects: 0,
      matchedProjects: 0,
      createdEnvironments: 0,
      matchedEnvironments: 0,
      createdSavedGroups: 0,
      matchedSavedGroups: 0,
      unsupportedSegments: 0,
      createdFeatures: 0,
      updatedFeatures: 0,
      importedTargetingRules: 0,
      createdVariationRules: 0,
      unsupportedOperators: 0,
      errors: 0,
    },
    actions: [],
  };

  const ld = createLdClient({
    baseUrl: LD_API_BASE_URL,
    token: LD_API_TOKEN,
    apiVersion: LD_API_VERSION,
    requestDelayMs: REQUEST_DELAY_MS,
  });

  const gb = createGbClient({
    apiBaseUrl: GB_API_BASE_URL,
    featuresApiBaseUrl: GB_FEATURES_API_BASE_URL,
    apiKey: GB_API_KEY,
    requestDelayMs: REQUEST_DELAY_MS,
  });

  console.log("Buscando projetos no LaunchDarkly...");
  const allLdProjects = await ld.listProjects();
  const ldProjects = allLdProjects.filter((project) => {
    if (isProjectIgnored(importConfig, project.key)) {
      report.actions.push({
        type: "project",
        action: "skipped_ignored",
        ldProjectKey: project.key,
      });
      return false;
    }
    return true;
  });
  report.totals.ldProjects = ldProjects.length;

  const ldEnvsByProject = new Map<string, LaunchDarklyEnvironment[]>();
  const ldFlagsByProject = new Map<string, LaunchDarklyFlagDetail[]>();
  const envKeyMapByProject = new Map<string, Map<string, string>>();

  for (const project of ldProjects) {
    const envs = await ld.listEnvironments(project.key);
    ldEnvsByProject.set(project.key, envs);
    report.totals.ldEnvironments += envs.length;
    envKeyMapByProject.set(
      project.key,
      buildEffectiveEnvKeyMap(importConfig, project.key, envs),
    );
    console.log(`LD ${project.key}: ${envs.length} environments`);
    await delay(REQUEST_DELAY_MS);

    const flags = await ld.listFlags(
      project.key,
      envs.map((env) => env.key),
    );
    ldFlagsByProject.set(project.key, flags);
    report.totals.ldFlags += flags.length;
    console.log(`LD ${project.key}: ${flags.length} flags`);
    await delay(REQUEST_DELAY_MS);
  }

  assertNoEnvironmentConflicts(
    importConfig,
    ldEnvsByProject,
    ldProjects.map((project) => project.key),
  );

  console.log("Buscando projetos/ambientes/saved groups no GrowthBook...");
  let gbProjects = await gb.listProjects();
  report.totals.gbProjects = gbProjects.length;

  let gbEnvironments = await gb.listEnvironments();
  report.totals.gbEnvironments = gbEnvironments.length;

  let gbSavedGroups = await gb.listSavedGroups();
  report.totals.gbSavedGroups = gbSavedGroups.length;

  const gbProjectByLdKey = new Map<string, GrowthBookProject>();

  console.log("Sincronizando projetos...");
  for (const ldProject of ldProjects) {
    const effective = remapProject(importConfig, ldProject.key, {
      key: ldProject.key,
      name: ldProject.name,
    });
    const decision = matchOrPlanCreateProject({
      ldProject,
      gbProjects,
      strategy: PROJECT_MATCH_STRATEGY,
      projectMap: PROJECT_MAP_JSON,
      allowCreate: MIGRATE_CREATE_PROJECTS,
      effectiveKey: effective.key,
      effectiveName: effective.name,
    });

    if (decision.action === "matched") {
      gbProjectByLdKey.set(ldProject.key, decision.gbProject);
      report.totals.matchedProjects += 1;
      report.actions.push({
        type: "project",
        action: "matched",
        ldProjectKey: ldProject.key,
        gbProjectId: decision.gbProject.id,
      });
      continue;
    }

    if (decision.action === "unmatched") {
      report.actions.push({
        type: "project",
        action: "missing_gb_project",
        ldProjectKey: ldProject.key,
        details: "Projeto sem match e MIGRATE_CREATE_PROJECTS=false",
      });
      continue;
    }

    if (DRY_RUN) {
      report.totals.createdProjects += 1;
      report.actions.push({
        type: "project",
        action: "would_create",
        ldProjectKey: ldProject.key,
        publicId: decision.publicId,
        name: decision.name,
      });

      // Placeholder so downstream dry-run can continue with a synthetic id.
      const synthetic: GrowthBookProject = {
        id: `dry-run-${ldProject.key}`,
        name: decision.name,
        publicId: decision.publicId,
      };
      gbProjectByLdKey.set(ldProject.key, synthetic);
      continue;
    }

    try {
      const created = await gb.createProject({
        name: decision.name,
        publicId: decision.publicId,
        description: decision.description,
      });
      gbProjects = [...gbProjects, created];
      gbProjectByLdKey.set(ldProject.key, created);
      report.totals.createdProjects += 1;
      report.actions.push({
        type: "project",
        action: "created",
        ldProjectKey: ldProject.key,
        gbProjectId: created.id,
      });
      await delay(REQUEST_DELAY_MS);
    } catch (error) {
      report.totals.errors += 1;
      report.actions.push({
        type: "project",
        action: "error",
        ldProjectKey: ldProject.key,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("Sincronizando ambientes...");
  const plannedEnvironments = planEnvironmentsForProjects({
    config: importConfig,
    ldEnvsByProject,
    activeProjectKeys: ldProjects.map((project) => project.key),
  });

  for (const planned of plannedEnvironments) {
    const gbProject = gbProjectByLdKey.get(planned.ldProjectKey);
    const decision = planEnvironmentUpsert({
      ldEnvironment: planned.ldEnvironment,
      gbEnvironments,
      gbProjectId:
        gbProject && !gbProject.id.startsWith("dry-run-")
          ? gbProject.id
          : undefined,
      effectiveId: planned.effectiveId,
      effectiveDescription: planned.effectiveDescription,
      strategy: planned.strategy,
      ldProjectKey: planned.ldProjectKey,
    });

    if (decision.action === "matched") {
      report.totals.matchedEnvironments += 1;
      report.actions.push({
        type: "environment",
        action: "matched",
        environmentKey: planned.effectiveId,
        ldEnvironmentKey: planned.ldEnvironment.key,
        ldProjectKey: planned.ldProjectKey,
        strategy: planned.strategy,
      });
      continue;
    }

    if (!MIGRATE_CREATE_ENVIRONMENTS) {
      report.actions.push({
        type: "environment",
        action: "skipped_create_disabled",
        environmentKey: planned.effectiveId,
        ldEnvironmentKey: planned.ldEnvironment.key,
        ldProjectKey: planned.ldProjectKey,
        strategy: planned.strategy,
      });
      continue;
    }

    if (DRY_RUN) {
      report.totals.createdEnvironments += 1;
      report.actions.push({
        type: "environment",
        action: "would_create",
        environmentKey: decision.id,
        description: decision.description,
        ldEnvironmentKey: planned.ldEnvironment.key,
        ldProjectKey: planned.ldProjectKey,
        strategy: planned.strategy,
        projects: decision.projects,
      });
      gbEnvironments = [
        ...gbEnvironments,
        {
          id: decision.id,
          description: decision.description,
          projects: decision.projects,
        },
      ];
      continue;
    }

    try {
      const created = await gb.createEnvironment({
        id: decision.id,
        description: decision.description,
        projects: decision.projects,
        defaultState: true,
        toggleOnList: true,
      });
      gbEnvironments = [...gbEnvironments, created];
      report.totals.createdEnvironments += 1;
      report.actions.push({
        type: "environment",
        action: "created",
        environmentKey: created.id,
        ldEnvironmentKey: planned.ldEnvironment.key,
        ldProjectKey: planned.ldProjectKey,
        strategy: planned.strategy,
      });
      await delay(REQUEST_DELAY_MS);
    } catch (error) {
      report.totals.errors += 1;
      report.actions.push({
        type: "environment",
        action: "error",
        environmentKey: planned.effectiveId,
        ldEnvironmentKey: planned.ldEnvironment.key,
        ldProjectKey: planned.ldProjectKey,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // segmentKey -> envKey -> savedGroupId
  const savedGroupIdByProjectEnvSegment = new Map<string, string>();

  console.log("Sincronizando segmentos → saved groups...");
  for (const ldProject of ldProjects) {
    const gbProject = gbProjectByLdKey.get(ldProject.key);
    if (!gbProject) continue;

    const envs = ldEnvsByProject.get(ldProject.key) ?? [];
    const envKeyMap = envKeyMapByProject.get(ldProject.key);
    for (const env of envs) {
      if (envKeyMap && !envKeyMap.has(env.key)) {
        report.actions.push({
          type: "segment",
          action: "skipped_ignored_environment",
          ldProjectKey: ldProject.key,
          environmentKey: env.key,
        });
        continue;
      }
      let segments;
      try {
        segments = await ld.listSegments(ldProject.key, env.key);
      } catch (error) {
        report.totals.errors += 1;
        report.actions.push({
          type: "segment",
          action: "error",
          ldProjectKey: ldProject.key,
          environmentKey: env.key,
          details: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      report.totals.ldSegments += segments.length;
      console.log(
        `LD ${ldProject.key}/${env.key}: ${segments.length} segments`,
      );

      for (const segment of segments) {
        const decision = planSegmentUpsert({
          ldProjectKey: ldProject.key,
          environmentKey: env.key,
          segment,
          existingSavedGroups: gbSavedGroups,
          gbProjectId: gbProject.id.startsWith("dry-run-")
            ? undefined
            : gbProject.id,
          listAttributeKey: SEGMENT_LIST_ATTRIBUTE_KEY,
        });

        if (decision.action === "unsupported") {
          report.totals.unsupportedSegments += 1;
          report.actions.push({
            type: "segment",
            action: "unsupported",
            ldProjectKey: ldProject.key,
            environmentKey: env.key,
            segmentKey: segment.key,
            savedGroupName: decision.savedGroupName,
            details: decision.reason,
          });
          continue;
        }

        if (decision.action === "matched") {
          report.totals.matchedSavedGroups += 1;
          savedGroupIdByProjectEnvSegment.set(
            `${ldProject.key}|${env.key}|${segment.key}`,
            decision.gbSavedGroup.id,
          );
          report.actions.push({
            type: "segment",
            action: "matched",
            ldProjectKey: ldProject.key,
            environmentKey: env.key,
            segmentKey: segment.key,
            savedGroupId: decision.gbSavedGroup.id,
          });
          continue;
        }

        if (!MIGRATE_CREATE_SAVED_GROUPS) {
          report.actions.push({
            type: "segment",
            action: "skipped_create_disabled",
            ldProjectKey: ldProject.key,
            environmentKey: env.key,
            segmentKey: segment.key,
          });
          continue;
        }

        if (DRY_RUN) {
          report.totals.createdSavedGroups += 1;
          const syntheticId = `dry-run-sg-${decision.savedGroupName}`;
          savedGroupIdByProjectEnvSegment.set(
            `${ldProject.key}|${env.key}|${segment.key}`,
            syntheticId,
          );
          gbSavedGroups = [
            ...gbSavedGroups,
            {
              id: syntheticId,
              name: decision.savedGroupName,
              type: decision.payload.type,
            },
          ];
          report.actions.push({
            type: "segment",
            action: "would_create",
            ldProjectKey: ldProject.key,
            environmentKey: env.key,
            segmentKey: segment.key,
            savedGroupName: decision.savedGroupName,
            payload: decision.payload,
          });
          continue;
        }

        try {
          const created = await gb.createSavedGroup(decision.payload);
          gbSavedGroups = [...gbSavedGroups, created];
          savedGroupIdByProjectEnvSegment.set(
            `${ldProject.key}|${env.key}|${segment.key}`,
            created.id,
          );
          report.totals.createdSavedGroups += 1;
          report.actions.push({
            type: "segment",
            action: "created",
            ldProjectKey: ldProject.key,
            environmentKey: env.key,
            segmentKey: segment.key,
            savedGroupId: created.id,
          });
          await delay(REQUEST_DELAY_MS);
        } catch (error) {
          report.totals.errors += 1;
          report.actions.push({
            type: "segment",
            action: "error",
            ldProjectKey: ldProject.key,
            environmentKey: env.key,
            segmentKey: segment.key,
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log("Sincronizando features e regras...");
  const gbFeaturesByProject = new Map<string, Map<string, GrowthBookFeature>>();

  for (const gbProject of gbProjects) {
    if (gbProject.id.startsWith("dry-run-")) {
      gbFeaturesByProject.set(gbProject.id, new Map());
      continue;
    }

    const features = await gb.listFeatures(gbProject.id);
    report.totals.gbFeatures += features.length;
    const index = new Map<string, GrowthBookFeature>();
    for (const feature of features) {
      index.set(feature.id, feature);
    }
    gbFeaturesByProject.set(gbProject.id, index);
    console.log(`GB ${gbProject.id}: ${features.length} features`);
    await delay(REQUEST_DELAY_MS);
  }

  for (const ldProject of ldProjects) {
    const gbProject = gbProjectByLdKey.get(ldProject.key);
    if (!gbProject) continue;

    const featureIndex =
      gbFeaturesByProject.get(gbProject.id) ??
      new Map<string, GrowthBookFeature>();
    const ldFlags = ldFlagsByProject.get(ldProject.key) ?? [];

    for (const ldFlag of ldFlags) {
      if (isFlagIgnored(importConfig, ldProject.key, ldFlag.key)) {
        report.actions.push({
          type: "feature",
          action: "skipped_ignored",
          ldProjectKey: ldProject.key,
          flagKey: ldFlag.key,
        });
        continue;
      }

      try {
        const remappedFlag = remapFlag(importConfig, ldProject.key, ldFlag.key, {
          key: ldFlag.key,
          name: ldFlag.name,
        });
        const envKeyMap = envKeyMapByProject.get(ldProject.key);

        const built = buildFeatureFromLdFlag({
          ldProjectKey: ldProject.key,
          ldFlag,
          gbProjectId: gbProject.id.startsWith("dry-run-")
            ? ""
            : gbProject.id,
          owner: GB_FEATURE_OWNER,
          effectiveFeatureId: remappedFlag.key,
          effectiveDescription:
            remappedFlag.name ?? ldFlag.description ?? ldFlag.name,
          envKeyMap,
          resolveSavedGroupIdForEnv: (environmentKey) => {
            return (segmentKey: string) =>
              savedGroupIdByProjectEnvSegment.get(
                `${ldProject.key}|${environmentKey}|${segmentKey}`,
              );
          },
        });

        for (const warning of built.warnings) {
          if (
            warning.kind === "unsupported_operator" ||
            warning.kind === "unsupported_segment"
          ) {
            report.totals.unsupportedOperators += 1;
          }
          report.actions.push({
            type: "warning",
            flagKey: ldFlag.key,
            ldProjectKey: ldProject.key,
            ...warning,
          });
        }

        const importedRules = MIGRATE_IMPORT_TARGETING
          ? built.importedRules
          : [];
        const environments = built.createPayload.environments;
        const existing = featureIndex.get(built.createPayload.id);

        if (!existing) {
          if (!MIGRATE_CREATE_FEATURES) {
            report.actions.push({
              type: "feature",
              action: "missing_gb_feature",
              ldProjectKey: ldProject.key,
              flagKey: ldFlag.key,
              details: "Feature ausente e MIGRATE_CREATE_FEATURES=false",
            });
            continue;
          }

          const createBody = {
            ...built.createPayload,
            project: gbProject.id.startsWith("dry-run-")
              ? undefined
              : gbProject.id,
            rules: normalizeRulesForGrowthBookApi(
              importedRules,
              built.valueType,
            ),
          };

          report.totals.importedTargetingRules += importedRules.length;

          if (DRY_RUN || gbProject.id.startsWith("dry-run-")) {
            report.totals.createdFeatures += 1;
            report.actions.push({
              type: "feature",
              action: "would_create",
              ldProjectKey: ldProject.key,
              flagKey: ldFlag.key,
              ruleCount: importedRules.length,
              valueType: built.valueType,
            });

            featureIndex.set(built.createPayload.id, {
              id: built.createPayload.id,
              valueType: built.valueType,
              defaultValue: built.defaultValue,
              rules: importedRules,
              environments: Object.fromEntries(
                Object.entries(environments).map(([key, value]) => [
                  key,
                  { enabled: value.enabled },
                ]),
              ),
              project: gbProject.id,
            });
            continue;
          }

          const created = await gb.createFeature(createBody);
          featureIndex.set(created.id, created);
          report.totals.createdFeatures += 1;
          report.actions.push({
            type: "feature",
            action: "created",
            ldProjectKey: ldProject.key,
            flagKey: ldFlag.key,
            gbFeatureId: created.id,
            ruleCount: importedRules.length,
          });
          await delay(REQUEST_DELAY_MS);
        } else if (MIGRATE_IMPORT_TARGETING) {
          const updatePlan = planFeatureUpdate({
            existingFeature: existing,
            importedRules,
            environments,
            defaultValue: built.defaultValue,
            description: built.createPayload.description,
            prerequisites: built.createPayload.prerequisites,
            archived: built.createPayload.archived,
          });

          if (!updatePlan.changed) {
            report.actions.push({
              type: "feature",
              action: "unchanged",
              ldProjectKey: ldProject.key,
              flagKey: ldFlag.key,
              gbFeatureId: existing.id,
            });
          } else {
            const normalizedRules = normalizeRulesForGrowthBookApi(
              updatePlan.body.rules,
              built.valueType,
            );

            report.totals.importedTargetingRules += updatePlan.createdCount;

            if (DRY_RUN) {
              report.totals.updatedFeatures += 1;
              report.actions.push({
                type: "feature",
                action: "would_update",
                ldProjectKey: ldProject.key,
                flagKey: ldFlag.key,
                gbFeatureId: existing.id,
                createdRules: updatePlan.createdCount,
                replacedRules: updatePlan.replacedCount,
              });
              featureIndex.set(existing.id, {
                ...existing,
                rules: updatePlan.body.rules,
                environments: Object.fromEntries(
                  Object.entries(environments).map(([key, value]) => [
                    key,
                    {
                      ...(existing.environments?.[key] ?? {}),
                      enabled: value.enabled,
                    },
                  ]),
                ),
              });
            } else {
              const updated = await gb.updateFeature(existing.id, {
                ...updatePlan.body,
                rules: normalizedRules,
              });
              featureIndex.set(updated.id, updated);
              report.totals.updatedFeatures += 1;
              report.actions.push({
                type: "feature",
                action: "updated",
                ldProjectKey: ldProject.key,
                flagKey: ldFlag.key,
                gbFeatureId: updated.id,
                createdRules: updatePlan.createdCount,
                replacedRules: updatePlan.replacedCount,
              });
              await delay(REQUEST_DELAY_MS);
            }
          }
        }

        if (MIGRATE_IMPORT_VARIATIONS) {
          const feature = featureIndex.get(built.createPayload.id);
          if (feature) {
            await backfillVariations({
              ldProject,
              ldFlag,
              gbProject,
              gbFeature: feature,
              report,
              importConfig,
              envKeyMap: envKeyMapByProject.get(ldProject.key),
              updateFeature: async (featureId, rules) => {
                if (DRY_RUN || gbProject.id.startsWith("dry-run-")) {
                  featureIndex.set(featureId, {
                    ...feature,
                    rules,
                  });
                  return;
                }

                const updated = await gb.updateFeature(featureId, { rules });
                featureIndex.set(updated.id, updated);
              },
            });
          }
        }
      } catch (error) {
        report.totals.errors += 1;
        report.actions.push({
          type: "feature",
          action: "error",
          ldProjectKey: ldProject.key,
          flagKey: ldFlag.key,
          details: error instanceof Error ? error.message : String(error),
        });
        console.error(`[ERRO] ${ldProject.key}/${ldFlag.key}`, error);
      }
    }

    gbFeaturesByProject.set(gbProject.id, featureIndex);
  }

  report.finishedAt = new Date().toISOString();
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("Migração finalizada.");
  console.log(`Relatório: ${REPORT_PATH}`);
  console.log(JSON.stringify(report.totals, null, 2));

  if (DRY_RUN) {
    console.log("");
    console.log(
      "DRY_RUN=true: nada foi enviado ao GrowthBook. Revise o relatório e rode com DRY_RUN=false para aplicar.",
    );
  }
}

async function backfillVariations(input: {
  ldProject: LaunchDarklyProject;
  ldFlag: LaunchDarklyFlagDetail;
  gbProject: GrowthBookProject;
  gbFeature: GrowthBookFeature;
  report: MigrateReport;
  importConfig: ImportConfig;
  envKeyMap?: Map<string, string>;
  updateFeature: (featureId: string, rules: GrowthBookFeature["rules"]) => Promise<void>;
}): Promise<void> {
  const { ldProject, ldFlag, gbFeature, report, importConfig, envKeyMap } =
    input;
  const targetEnvKeys = Object.keys(gbFeature.environments ?? {}).length
    ? Object.keys(gbFeature.environments ?? {})
    : envKeyMap && envKeyMap.size > 0
      ? [...envKeyMap.values()]
      : Object.keys(ldFlag.environments ?? {});

  if (targetEnvKeys.length === 0) {
    report.actions.push({
      type: "variation",
      action: "no_target_environments",
      ldProjectKey: ldProject.key,
      flagKey: ldFlag.key,
      gbFeatureId: gbFeature.id,
    });
    return;
  }

  const remappedFlag = remapFlag(importConfig, ldProject.key, ldFlag.key, {
    key: ldFlag.key,
    name: ldFlag.name,
  });
  const effectiveFlagKey = remappedFlag.key;

  const filteredVariations = filterAndRemapVariations(
    importConfig,
    ldProject.key,
    ldFlag.key,
    ldFlag.variations ?? [],
  );

  const ldVariations = uniqueLdVariationsByValue(
    filteredVariations,
    gbFeature.valueType,
  );

  const missingVariations = findMissingLdVariations({
    ldVariations,
    feature: gbFeature,
    ldProjectKey: ldProject.key,
    flagKey: effectiveFlagKey,
  });

  const newRules = missingVariations.map((variation) =>
    buildDisabledGrowthBookRule({
      ldProject,
      ldFlag: { ...ldFlag, key: effectiveFlagKey },
      gbFeature,
      variation,
      environments: targetEnvKeys,
    }),
  );

  const syncResult = syncFeatureRules({
    existingRules: getFeatureRules(gbFeature),
    newRules,
    targetEnvironments: targetEnvKeys,
    valueType: gbFeature.valueType,
  });

  if (!syncResult.changed || syncResult.createdCount === 0) {
    return;
  }

  const normalizedRules = normalizeRulesForGrowthBookApi(
    syncResult.rules,
    gbFeature.valueType,
  );

  report.totals.createdVariationRules += syncResult.createdCount;
  report.actions.push({
    type: "variation",
    action: DRY_RUN ? "would_add_rules" : "added_rules",
    ldProjectKey: ldProject.key,
    flagKey: ldFlag.key,
    gbFeatureId: gbFeature.id,
    ruleCount: syncResult.createdCount,
    variations: missingVariations.map((variation) => ({
      ldVariationName: variation.name,
      ldVariationKey: variation.key ?? variation._id ?? variation.id,
      valueHash: hashValue(variation.value),
      valuePreview: previewValue(variation.value),
    })),
  });

  await input.updateFeature(gbFeature.id, normalizedRules);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
