import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { createGbClient } from "./api/gb-client.js";
import { createLdClient } from "./api/ld-client.js";
import {
  delay,
  deriveFeaturesApiBaseUrl,
  parseBoolean,
  parseCsv,
  parseProjectMap,
  requiredEnv,
} from "./api/http.js";
import {
  defaultConfigPath,
  filterAndRemapVariations,
  isFlagIgnored,
  isProjectIgnored,
  loadImportConfig,
  remapFlag,
  remapProject,
  sanitizeFeatureId,
  summarizeImportConfig,
  type ImportConfig,
} from "./config.js";
import { matchOrPlanCreateProject } from "./mappers/projects.js";
import { normalizeRulesForGrowthBookApi } from "./normalize-rules.js";
import type { GrowthBookProject } from "./types/migrate.js";
import {
  type GrowthBookFeature,
  type LaunchDarklyFlag,
  type LaunchDarklyProject,
  buildDisabledGrowthBookRule,
  findMissingLdVariations,
  getFeatureRules,
  hashValue,
  previewValue,
  syncFeatureRules,
  uniqueLdVariationsByValue,
} from "./variation-dedupe.js";

type Report = {
  startedAt: string;
  finishedAt?: string;
  dryRun: boolean;
  config: {
    configPath: string;
    importConfig: Record<string, unknown>;
    projectMatchStrategy: string;
    gbEnvStrategy: string;
    allowCreateEnvBlocks: boolean;
    gbApiBaseUrl: string;
    gbFeaturesApiBaseUrl: string;
  };
  totals: {
    ldProjects: number;
    ldFlags: number;
    gbProjects: number;
    gbFeatures: number;
    matchedProjects: number;
    matchedFeatures: number;
    updatedFeatures: number;
    createdRules: number;
    consolidatedRules: number;
    expandedRules: number;
    skippedFlagsWithoutGbProject: number;
    skippedFlagsWithoutGbFeature: number;
    skippedFeaturesWithoutTargetEnvironments: number;
    errors: number;
  };
  projectMatches: Array<{
    ldProjectKey: string;
    ldProjectName: string;
    gbProjectId: string;
    gbProjectName: string;
    gbProjectPublicId?: string;
  }>;
  actions: Array<{
    ldProjectKey: string;
    gbProjectId?: string;
    flagKey: string;
    gbFeatureId?: string;
    envKeys?: string[];
    action:
      | "would_add_rules"
      | "added_rules"
      | "would_consolidate_rules"
      | "consolidated_rules"
      | "no_missing_variations"
      | "missing_gb_project"
      | "missing_gb_feature"
      | "no_target_environments"
      | "skipped_ignored"
      | "error";
    ruleCount?: number;
    consolidatedCount?: number;
    expandedCount?: number;
    details?: string;
    variations?: Array<{
      ldVariationName?: string;
      ldVariationKey?: string;
      valueHash: string;
      valuePreview: string;
    }>;
  }>;
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

const GB_ENV_STRATEGY = process.env.GB_ENV_STRATEGY?.trim() || "existing";
const GB_TARGET_ENVIRONMENTS = parseCsv(process.env.GB_TARGET_ENVIRONMENTS);
const ALLOW_CREATE_ENV_BLOCKS = parseBoolean(
  process.env.ALLOW_CREATE_ENV_BLOCKS,
  false,
);

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? "250");
const REPORT_PATH =
  process.env.REPORT_PATH ?? "./ld-growthbook-variation-report.json";
const CONFIG_PATH = defaultConfigPath();

async function main() {
  console.log(`Carregando e validando config: ${CONFIG_PATH}`);
  const importConfig = await loadImportConfig(CONFIG_PATH);

  const report: Report = {
    startedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    config: {
      configPath: CONFIG_PATH,
      importConfig: summarizeImportConfig(importConfig),
      projectMatchStrategy: PROJECT_MATCH_STRATEGY,
      gbEnvStrategy: GB_ENV_STRATEGY,
      allowCreateEnvBlocks: ALLOW_CREATE_ENV_BLOCKS,
      gbApiBaseUrl: GB_API_BASE_URL,
      gbFeaturesApiBaseUrl: GB_FEATURES_API_BASE_URL,
    },
    totals: {
      ldProjects: 0,
      ldFlags: 0,
      gbProjects: 0,
      gbFeatures: 0,
      matchedProjects: 0,
      matchedFeatures: 0,
      updatedFeatures: 0,
      createdRules: 0,
      consolidatedRules: 0,
      expandedRules: 0,
      skippedFlagsWithoutGbProject: 0,
      skippedFlagsWithoutGbFeature: 0,
      skippedFeaturesWithoutTargetEnvironments: 0,
      errors: 0,
    },
    projectMatches: [],
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
        ldProjectKey: project.key,
        flagKey: "*",
        action: "skipped_ignored",
        details: "Projeto ignorado via config.json",
      });
      return false;
    }
    return true;
  });
  report.totals.ldProjects = ldProjects.length;

  console.log("Buscando flags e variações no LaunchDarkly...");
  const ldFlagsByProject = new Map<string, LaunchDarklyFlag[]>();

  for (const project of ldProjects) {
    const envs = await ld.listEnvironments(project.key);
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

  console.log("Buscando projetos no GrowthBook...");
  const gbProjects = await gb.listProjects();
  report.totals.gbProjects = gbProjects.length;

  const gbProjectByLdProjectKey = matchProjects(
    ldProjects,
    gbProjects,
    importConfig,
  );

  for (const [ldProjectKey, gbProject] of gbProjectByLdProjectKey.entries()) {
    const ldProject = ldProjects.find((p) => p.key === ldProjectKey);
    if (!ldProject) continue;

    report.totals.matchedProjects += 1;
    report.projectMatches.push({
      ldProjectKey: ldProject.key,
      ldProjectName: ldProject.name,
      gbProjectId: gbProject.id,
      gbProjectName: gbProject.name,
      gbProjectPublicId: gbProject.publicId,
    });
  }

  console.log("Buscando features no GrowthBook por projeto...");
  const gbFeatureIndexByProject = new Map<string, Map<string, GrowthBookFeature>>();

  for (const gbProject of gbProjects) {
    const features = await gb.listFeatures(gbProject.id);
    report.totals.gbFeatures += features.length;

    const index = new Map<string, GrowthBookFeature>();
    for (const feature of features) {
      index.set(feature.id, feature);
    }
    gbFeatureIndexByProject.set(gbProject.id, index);

    console.log(`GB ${gbProject.id}: ${features.length} features`);
    await delay(REQUEST_DELAY_MS);
  }

  console.log("Comparando variações LD x regras GrowthBook...");

  for (const ldProject of ldProjects) {
    const gbProject = gbProjectByLdProjectKey.get(ldProject.key);
    const ldFlags = ldFlagsByProject.get(ldProject.key) ?? [];

    if (!gbProject) {
      for (const ldFlag of ldFlags) {
        report.totals.skippedFlagsWithoutGbProject += 1;
        report.actions.push({
          ldProjectKey: ldProject.key,
          flagKey: ldFlag.key,
          action: "missing_gb_project",
          details:
            "Não foi encontrado projeto correspondente no GrowthBook. Use PROJECT_MAP_JSON se o importador mudou nomes/ids.",
        });
      }
      continue;
    }

    const gbFeatureIndex = gbFeatureIndexByProject.get(gbProject.id);
    if (!gbFeatureIndex) {
      continue;
    }

    for (const ldFlag of ldFlags) {
      if (isFlagIgnored(importConfig, ldProject.key, ldFlag.key)) {
        report.actions.push({
          ldProjectKey: ldProject.key,
          gbProjectId: gbProject.id,
          flagKey: ldFlag.key,
          action: "skipped_ignored",
          details: "Flag ignorada via config.json",
        });
        continue;
      }

      const remappedFlag = remapFlag(importConfig, ldProject.key, ldFlag.key, {
        key: ldFlag.key,
        name: ldFlag.name,
      });
      const effectiveFlagKey = sanitizeFeatureId(remappedFlag.key);
      const gbFeature = gbFeatureIndex.get(effectiveFlagKey);

      if (!gbFeature) {
        report.totals.skippedFlagsWithoutGbFeature += 1;
        report.actions.push({
          ldProjectKey: ldProject.key,
          gbProjectId: gbProject.id,
          flagKey: ldFlag.key,
          action: "missing_gb_feature",
          details:
            `A flag existe no LaunchDarkly, mas não foi encontrada no GrowthBook com id/key "${effectiveFlagKey}".`,
        });
        continue;
      }

      report.totals.matchedFeatures += 1;

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
      if (ldVariations.length === 0) {
        report.actions.push({
          ldProjectKey: ldProject.key,
          gbProjectId: gbProject.id,
          flagKey: ldFlag.key,
          gbFeatureId: gbFeature.id,
          action: "no_missing_variations",
          details: "Flag sem variações no payload do LaunchDarkly (após filtros do config).",
        });
        continue;
      }

      const targetEnvKeys = resolveTargetEnvironmentKeys(gbFeature);

      if (targetEnvKeys.length === 0) {
        report.totals.skippedFeaturesWithoutTargetEnvironments += 1;
        report.actions.push({
          ldProjectKey: ldProject.key,
          gbProjectId: gbProject.id,
          flagKey: ldFlag.key,
          gbFeatureId: gbFeature.id,
          action: "no_target_environments",
          details:
            "Nenhum environment alvo foi encontrado. Por segurança, o script não cria blocos environments novos por padrão.",
        });
        continue;
      }

      const existingRules = getFeatureRules(gbFeature);
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
        existingRules,
        newRules,
        targetEnvironments: targetEnvKeys,
        valueType: gbFeature.valueType,
      });

      if (!syncResult.changed) {
        report.actions.push({
          ldProjectKey: ldProject.key,
          gbProjectId: gbProject.id,
          flagKey: ldFlag.key,
          gbFeatureId: gbFeature.id,
          envKeys: targetEnvKeys,
          action: "no_missing_variations",
        });
        continue;
      }

      const normalizedRules = normalizeRulesForGrowthBookApi(
        syncResult.rules,
        gbFeature.valueType,
      );

      report.totals.createdRules += syncResult.createdCount;
      report.totals.consolidatedRules += syncResult.consolidatedCount;
      report.totals.expandedRules += syncResult.expandedCount;

      const action =
        syncResult.createdCount > 0
          ? DRY_RUN
            ? "would_add_rules"
            : "added_rules"
          : DRY_RUN
            ? "would_consolidate_rules"
            : "consolidated_rules";

      report.actions.push({
        ldProjectKey: ldProject.key,
        gbProjectId: gbProject.id,
        flagKey: ldFlag.key,
        gbFeatureId: gbFeature.id,
        envKeys: targetEnvKeys,
        action,
        ruleCount: syncResult.createdCount,
        consolidatedCount: syncResult.consolidatedCount,
        expandedCount: syncResult.expandedCount,
        variations: missingVariations.map((variation) => ({
          ldVariationName: variation.name,
          ldVariationKey: variation.key ?? variation._id ?? variation.id,
          valueHash: hashValue(variation.value),
          valuePreview: previewValue(variation.value),
        })),
      });

      if (DRY_RUN) {
        console.log(
          `[DRY_RUN] ${gbFeature.id}: +${syncResult.createdCount} regras, ` +
            `${syncResult.consolidatedCount} consolidadas, ` +
            `${syncResult.expandedCount} environments expandidos ` +
            `(envs: ${targetEnvKeys.join(", ")})`,
        );
        continue;
      }

      try {
        await gb.updateFeature(gbFeature.id, {
          rules: normalizedRules,
        });

        report.totals.updatedFeatures += 1;

        console.log(
          `[OK] ${gbFeature.id}: +${syncResult.createdCount} regras, ` +
            `${syncResult.consolidatedCount} consolidadas, ` +
            `${syncResult.expandedCount} environments expandidos`,
        );

        await delay(REQUEST_DELAY_MS);
      } catch (error) {
        report.totals.errors += 1;
        report.actions.push({
          ldProjectKey: ldProject.key,
          gbProjectId: gbProject.id,
          flagKey: ldFlag.key,
          gbFeatureId: gbFeature.id,
          action: "error",
          details: error instanceof Error ? error.message : String(error),
        });

        console.error(`[ERRO] ${gbFeature.id}`, error);
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("Finalizado.");
  console.log(`Relatório: ${REPORT_PATH}`);
  console.log(JSON.stringify(report.totals, null, 2));

  if (DRY_RUN) {
    console.log("");
    console.log(
      "DRY_RUN=true: nada foi enviado ao GrowthBook. Revise o relatório e rode com DRY_RUN=false para aplicar.",
    );
  }
}

function resolveTargetEnvironmentKeys(feature: GrowthBookFeature): string[] {
  const existingEnvKeys = Object.keys(feature.environments ?? {});

  if (GB_ENV_STRATEGY === "existing") {
    return existingEnvKeys;
  }

  if (GB_ENV_STRATEGY === "list") {
    if (GB_TARGET_ENVIRONMENTS.length === 0) {
      throw new Error(
        "GB_ENV_STRATEGY=list exige GB_TARGET_ENVIRONMENTS=env1,env2,...",
      );
    }

    if (ALLOW_CREATE_ENV_BLOCKS) {
      return GB_TARGET_ENVIRONMENTS;
    }

    return GB_TARGET_ENVIRONMENTS.filter((envKey) =>
      existingEnvKeys.includes(envKey),
    );
  }

  throw new Error(
    `GB_ENV_STRATEGY inválida: ${GB_ENV_STRATEGY}. Use "existing" ou "list".`,
  );
}

function matchProjects(
  ldProjects: LaunchDarklyProject[],
  gbProjects: GrowthBookProject[],
  importConfig: ImportConfig,
): Map<string, GrowthBookProject> {
  const result = new Map<string, GrowthBookProject>();

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
      allowCreate: false,
      effectiveKey: effective.key,
      effectiveName: effective.name,
    });

    if (decision.action === "matched") {
      result.set(ldProject.key, decision.gbProject);
    }
  }

  return result;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
