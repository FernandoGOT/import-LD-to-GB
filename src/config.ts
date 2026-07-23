import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

export type EnvironmentStrategy = "shared" | "unique";

export type KeyNameRemap = {
  key?: string;
  name?: string;
};

export type IgnoreRemapSection = {
  ignore: string[];
  remap: Record<string, KeyNameRemap>;
};

export type ProjectRemapEntry = KeyNameRemap & {
  environmentStrategy?: EnvironmentStrategy;
  environments?: IgnoreRemapSection;
};

export type FlagScope = {
  projectKey: string;
  flagKey: string;
};

export type FlagRemapEntry = FlagScope & KeyNameRemap;

export type VariationScope = FlagScope & {
  variationId: string;
};

export type VariationRemapEntry = VariationScope & KeyNameRemap;

export type ImportConfig = {
  projects: {
    ignore: string[];
    remap: Record<string, ProjectRemapEntry>;
  };
  environments: IgnoreRemapSection;
  flags: {
    ignore: FlagScope[];
    remap: FlagRemapEntry[];
  };
  variations: {
    ignore: VariationScope[];
    remap: VariationRemapEntry[];
  };
};

export type EnvironmentTarget = {
  origin: string;
  ldProjectKey?: string;
  ldEnvKey: string;
  key: string;
  name: string;
};

export type VariationLike = {
  key?: string;
  _id?: string;
  id?: string;
  name?: string;
};

const EMPTY_IGNORE_REMAP: IgnoreRemapSection = {
  ignore: [],
  remap: {},
};

export function emptyImportConfig(): ImportConfig {
  return {
    projects: { ignore: [], remap: {} },
    environments: { ignore: [], remap: {} },
    flags: { ignore: [], remap: [] },
    variations: { ignore: [], remap: [] },
  };
}

export function defaultConfigPath(): string {
  return process.env.CONFIG_PATH?.trim() || "./config.json";
}

export async function loadImportConfig(
  path = defaultConfigPath(),
): Promise<ImportConfig> {
  try {
    await access(path, constants.R_OK);
  } catch {
    return emptyImportConfig();
  }

  let raw: unknown;
  try {
    const text = await readFile(path, "utf8");
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Falha ao ler/parsear config em ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const config = normalizeImportConfig(raw);
  validateImportConfig(config);
  return config;
}

export function normalizeImportConfig(raw: unknown): ImportConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json deve ser um objeto JSON na raiz.");
  }

  const root = raw as Record<string, unknown>;
  const allowed = new Set([
    "projects",
    "environments",
    "flags",
    "variations",
  ]);

  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Seção desconhecida no config.json: "${key}". Use apenas projects, environments, flags, variations.`,
      );
    }
  }

  return {
    projects: normalizeProjects(root.projects),
    environments: normalizeIgnoreRemapSection(
      root.environments,
      "environments",
    ),
    flags: normalizeFlags(root.flags),
    variations: normalizeVariations(root.variations),
  };
}

export function validateImportConfig(config: ImportConfig): void {
  const errors: string[] = [];

  for (const projectKey of config.projects.ignore) {
    if (config.projects.remap[projectKey]) {
      errors.push(
        `projects: "${projectKey}" não pode estar em ignore e remap ao mesmo tempo.`,
      );
    }
  }

  for (const [projectKey, entry] of Object.entries(config.projects.remap)) {
    if (
      !entry.key &&
      !entry.name &&
      !entry.environmentStrategy &&
      !entry.environments
    ) {
      errors.push(
        `projects.remap["${projectKey}"]: informe key, name, environmentStrategy e/ou environments.`,
      );
    }

    if (
      entry.environmentStrategy &&
      entry.environmentStrategy !== "shared" &&
      entry.environmentStrategy !== "unique"
    ) {
      errors.push(
        `projects.remap["${projectKey}"].environmentStrategy inválida: ${entry.environmentStrategy}. Use "shared" ou "unique".`,
      );
    }

    if (entry.key && !isValidGbKey(entry.key)) {
      errors.push(
        `projects.remap["${projectKey}"].key inválida: "${entry.key}". Use apenas A-Z, a-z, 0-9, _ e -.`,
      );
    }

    if (entry.environments) {
      validateIgnoreRemapConflicts(
        entry.environments,
        `projects.remap["${projectKey}"].environments`,
        errors,
      );
      for (const [ldEnvKey, remap] of Object.entries(
        entry.environments.remap,
      )) {
        if (remap.key && !isValidGbKey(remap.key)) {
          errors.push(
            `projects.remap["${projectKey}"].environments.remap["${ldEnvKey}"].key inválida: "${remap.key}".`,
          );
        }
      }
    }
  }

  validateIgnoreRemapConflicts(config.environments, "environments", errors);
  for (const [ldEnvKey, remap] of Object.entries(config.environments.remap)) {
    if (remap.key && !isValidGbKey(remap.key)) {
      errors.push(
        `environments.remap["${ldEnvKey}"].key inválida: "${remap.key}".`,
      );
    }
  }

  validateFlagEntries(config, errors);
  validateVariationEntries(config, errors);

  // Config-only environment target collisions among declared remaps / strategies.
  const declaredTargets = collectDeclaredEnvironmentTargets(config);
  errors.push(...findEnvironmentTargetConflicts(declaredTargets));

  if (errors.length > 0) {
    throw new Error(
      `config.json inválido (${errors.length} erro(s)):\n- ${errors.join("\n- ")}`,
    );
  }
}

/**
 * Revalidate environment id/name conflicts using real LD environment keys.
 * Call after fetching LD projects/environments.
 */
export function assertNoEnvironmentConflicts(
  config: ImportConfig,
  ldEnvsByProject: Map<string, Array<{ key: string; name: string }>>,
  activeProjectKeys?: string[],
): void {
  const targets = collectPlannedEnvironmentTargets(
    config,
    ldEnvsByProject,
    activeProjectKeys,
  );
  const errors = findEnvironmentTargetConflicts(targets);
  if (errors.length > 0) {
    throw new Error(
      `Conflito de ambientes no config/LD (${errors.length} erro(s)):\n- ${errors.join("\n- ")}`,
    );
  }
}

export function getEnvironmentStrategy(
  config: ImportConfig,
  ldProjectKey: string,
): EnvironmentStrategy {
  return (
    config.projects.remap[ldProjectKey]?.environmentStrategy ?? "shared"
  );
}

export function isProjectIgnored(
  config: ImportConfig,
  ldProjectKey: string,
): boolean {
  return config.projects.ignore.includes(ldProjectKey);
}

export function remapProject(
  config: ImportConfig,
  ldProjectKey: string,
  current: { key: string; name: string },
): { key: string; name: string } {
  const entry = config.projects.remap[ldProjectKey];
  if (!entry) return current;
  return {
    key: entry.key?.trim() || current.key,
    name: entry.name?.trim() || current.name,
  };
}

export function isEnvironmentIgnored(
  config: ImportConfig,
  ldProjectKey: string,
  ldEnvKey: string,
): boolean {
  if (getEnvironmentStrategy(config, ldProjectKey) === "unique") {
    const local = config.projects.remap[ldProjectKey]?.environments;
    return Boolean(local?.ignore.includes(ldEnvKey));
  }
  return config.environments.ignore.includes(ldEnvKey);
}

export function resolveEffectiveEnvironmentTarget(
  config: ImportConfig,
  ldProjectKey: string,
  ldEnv: { key: string; name: string },
): { key: string; name: string } {
  const strategy = getEnvironmentStrategy(config, ldProjectKey);

  if (strategy === "unique") {
    const local =
      config.projects.remap[ldProjectKey]?.environments?.remap[ldEnv.key];
    const effectiveProjectKey = remapProject(config, ldProjectKey, {
      key: ldProjectKey,
      name: ldProjectKey,
    }).key;
    const autoKey = sanitizeGbKey(`${effectiveProjectKey}__${ldEnv.key}`);
    return {
      key: local?.key?.trim() || autoKey,
      name: local?.name?.trim() || ldEnv.name,
    };
  }

  const shared = config.environments.remap[ldEnv.key];
  return {
    key: shared?.key?.trim() || ldEnv.key,
    name: shared?.name?.trim() || ldEnv.name,
  };
}

export function buildEffectiveEnvKeyMap(
  config: ImportConfig,
  ldProjectKey: string,
  ldEnvs: Array<{ key: string; name: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const ldEnv of ldEnvs) {
    if (isEnvironmentIgnored(config, ldProjectKey, ldEnv.key)) continue;
    const target = resolveEffectiveEnvironmentTarget(
      config,
      ldProjectKey,
      ldEnv,
    );
    map.set(ldEnv.key, target.key);
  }
  return map;
}

export function isFlagIgnored(
  config: ImportConfig,
  projectKey: string,
  flagKey: string,
): boolean {
  return config.flags.ignore.some(
    (entry) => entry.projectKey === projectKey && entry.flagKey === flagKey,
  );
}

export function remapFlag(
  config: ImportConfig,
  projectKey: string,
  flagKey: string,
  current: { key: string; name?: string },
): { key: string; name?: string } {
  const entry = config.flags.remap.find(
    (item) => item.projectKey === projectKey && item.flagKey === flagKey,
  );
  if (!entry) return current;
  return {
    key: entry.key?.trim() || current.key,
    name: entry.name?.trim() || current.name,
  };
}

export function sanitizeFeatureId(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function resolveVariationSourceId(
  variation: VariationLike,
  index: number,
): string {
  if (variation.key?.trim()) return variation.key.trim();
  if (variation._id?.trim()) return variation._id.trim();
  if (variation.id?.trim()) return variation.id.trim();
  return String(index);
}

export function isVariationIgnored(
  config: ImportConfig,
  projectKey: string,
  flagKey: string,
  variation: VariationLike,
  index: number,
): boolean {
  const variationId = resolveVariationSourceId(variation, index);
  return config.variations.ignore.some(
    (entry) =>
      entry.projectKey === projectKey &&
      entry.flagKey === flagKey &&
      entry.variationId === variationId,
  );
}

export function remapVariation(
  config: ImportConfig,
  projectKey: string,
  flagKey: string,
  variation: VariationLike,
  index: number,
): VariationLike {
  const variationId = resolveVariationSourceId(variation, index);
  const entry = config.variations.remap.find(
    (item) =>
      item.projectKey === projectKey &&
      item.flagKey === flagKey &&
      item.variationId === variationId,
  );
  if (!entry) return variation;
  return {
    ...variation,
    key: entry.key?.trim() || variation.key,
    name: entry.name?.trim() || variation.name,
  };
}

export function filterAndRemapVariations<T extends VariationLike>(
  config: ImportConfig,
  projectKey: string,
  flagKey: string,
  variations: T[],
): T[] {
  return variations
    .map((variation, index) => {
      if (isVariationIgnored(config, projectKey, flagKey, variation, index)) {
        return null;
      }
      return remapVariation(
        config,
        projectKey,
        flagKey,
        variation,
        index,
      ) as T;
    })
    .filter((item): item is T => item !== null);
}

export function collectDeclaredEnvironmentTargets(
  config: ImportConfig,
): EnvironmentTarget[] {
  const targets: EnvironmentTarget[] = [];

  for (const [ldEnvKey, remap] of Object.entries(config.environments.remap)) {
    targets.push({
      origin: "shared",
      ldEnvKey,
      key: remap.key?.trim() || ldEnvKey,
      name: remap.name?.trim() || ldEnvKey,
    });
  }

  for (const [ldProjectKey, entry] of Object.entries(config.projects.remap)) {
    if ((entry.environmentStrategy ?? "shared") !== "unique") continue;
    const localRemap = entry.environments?.remap ?? {};
    for (const [ldEnvKey, remap] of Object.entries(localRemap)) {
      const effectiveProjectKey = entry.key?.trim() || ldProjectKey;
      targets.push({
        origin: `unique:${ldProjectKey}`,
        ldProjectKey,
        ldEnvKey,
        key: remap.key?.trim() || sanitizeGbKey(`${effectiveProjectKey}__${ldEnvKey}`),
        name: remap.name?.trim() || ldEnvKey,
      });
    }
  }

  return targets;
}

export function collectPlannedEnvironmentTargets(
  config: ImportConfig,
  ldEnvsByProject: Map<string, Array<{ key: string; name: string }>>,
  activeProjectKeys?: string[],
): EnvironmentTarget[] {
  const targets: EnvironmentTarget[] = [];
  const projectKeys =
    activeProjectKeys ??
    [...ldEnvsByProject.keys()].filter(
      (key) => !isProjectIgnored(config, key),
    );

  const sharedEnvKeys = new Map<string, { key: string; name: string }>();

  for (const ldProjectKey of projectKeys) {
    if (isProjectIgnored(config, ldProjectKey)) continue;
    if (getEnvironmentStrategy(config, ldProjectKey) !== "shared") continue;

    for (const ldEnv of ldEnvsByProject.get(ldProjectKey) ?? []) {
      if (isEnvironmentIgnored(config, ldProjectKey, ldEnv.key)) continue;
      if (!sharedEnvKeys.has(ldEnv.key)) {
        sharedEnvKeys.set(ldEnv.key, ldEnv);
      }
    }
  }

  for (const [ldEnvKey, ldEnv] of sharedEnvKeys) {
    const shared = config.environments.remap[ldEnvKey];
    targets.push({
      origin: "shared",
      ldEnvKey,
      key: shared?.key?.trim() || ldEnvKey,
      name: shared?.name?.trim() || ldEnv.name,
    });
  }

  for (const ldProjectKey of projectKeys) {
    if (isProjectIgnored(config, ldProjectKey)) continue;
    if (getEnvironmentStrategy(config, ldProjectKey) !== "unique") continue;

    for (const ldEnv of ldEnvsByProject.get(ldProjectKey) ?? []) {
      if (isEnvironmentIgnored(config, ldProjectKey, ldEnv.key)) continue;
      const resolved = resolveEffectiveEnvironmentTarget(
        config,
        ldProjectKey,
        ldEnv,
      );
      targets.push({
        origin: `unique:${ldProjectKey}`,
        ldProjectKey,
        ldEnvKey: ldEnv.key,
        key: resolved.key,
        name: resolved.name,
      });
    }
  }

  return targets;
}

export function findEnvironmentTargetConflicts(
  targets: EnvironmentTarget[],
): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, EnvironmentTarget[]>();
  const byName = new Map<string, EnvironmentTarget[]>();

  for (const target of targets) {
    const keyBucket = byKey.get(target.key) ?? [];
    keyBucket.push(target);
    byKey.set(target.key, keyBucket);

    const nameNorm = normalizeName(target.name);
    if (nameNorm) {
      const nameBucket = byName.get(nameNorm) ?? [];
      nameBucket.push(target);
      byName.set(nameNorm, nameBucket);
    }
  }

  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    if (!hasCrossOriginConflict(group)) continue;
    errors.push(
      `environment id "${key}" conflita entre: ${group
        .map(formatTargetOrigin)
        .join(" | ")}`,
    );
  }

  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    if (!hasCrossOriginConflict(group)) continue;
    // Same origin shared consolidating identical names is ok only if same key —
    // cross-origin name clash is always an error per plan.
    errors.push(
      `environment name "${name}" conflita entre: ${group
        .map(formatTargetOrigin)
        .join(" | ")}`,
    );
  }

  return errors;
}

function hasCrossOriginConflict(group: EnvironmentTarget[]): boolean {
  const origins = new Set(group.map((item) => item.origin));
  if (origins.size > 1) return true;
  // Same origin: still conflict if multiple distinct ld env keys map to same target
  // (shared internal or unique internal).
  const ldKeys = new Set(group.map((item) => `${item.ldProjectKey ?? ""}:${item.ldEnvKey}`));
  return ldKeys.size > 1;
}

function formatTargetOrigin(target: EnvironmentTarget): string {
  if (target.origin === "shared") {
    return `shared LD env "${target.ldEnvKey}" → ${target.key}/${target.name}`;
  }
  return `${target.origin} LD env "${target.ldEnvKey}" → ${target.key}/${target.name}`;
}

function validateIgnoreRemapConflicts(
  section: IgnoreRemapSection,
  label: string,
  errors: string[],
): void {
  for (const key of section.ignore) {
    if (section.remap[key]) {
      errors.push(
        `${label}: "${key}" não pode estar em ignore e remap ao mesmo tempo.`,
      );
    }
  }

  const targetKeys = new Map<string, string>();
  for (const [source, remap] of Object.entries(section.remap)) {
    if (!remap.key && !remap.name) {
      errors.push(
        `${label}.remap["${source}"]: informe ao menos key ou name.`,
      );
      continue;
    }
    if (!remap.key) continue;
    const existing = targetKeys.get(remap.key);
    if (existing && existing !== source) {
      errors.push(
        `${label}: "${existing}" e "${source}" remapeiam para a mesma key "${remap.key}".`,
      );
    } else {
      targetKeys.set(remap.key, source);
    }
  }
}

function validateFlagEntries(config: ImportConfig, errors: string[]): void {
  const ignoreScopes = new Set<string>();
  for (const entry of config.flags.ignore) {
    const scope = flagScopeKey(entry);
    if (ignoreScopes.has(scope)) {
      errors.push(`flags.ignore duplicado: ${scope}`);
    }
    ignoreScopes.add(scope);
  }

  const remapScopes = new Set<string>();
  const targetKeysByProject = new Map<string, Map<string, string>>();

  for (const entry of config.flags.remap) {
    const scope = flagScopeKey(entry);
    if (remapScopes.has(scope)) {
      errors.push(`flags.remap duplicado: ${scope}`);
    }
    remapScopes.add(scope);

    if (ignoreScopes.has(scope)) {
      errors.push(
        `flags: ${scope} não pode estar em ignore e remap ao mesmo tempo.`,
      );
    }

    if (!entry.key && !entry.name) {
      errors.push(
        `flags.remap ${scope}: informe ao menos key ou name.`,
      );
    }

    if (entry.key) {
      const sanitized = sanitizeFeatureId(entry.key);
      if (!isValidGbKey(sanitized)) {
        errors.push(`flags.remap ${scope}: key inválida "${entry.key}".`);
      }
      const byProject =
        targetKeysByProject.get(entry.projectKey) ?? new Map<string, string>();
      const existing = byProject.get(sanitized);
      if (existing && existing !== scope) {
        errors.push(
          `flags: no projeto "${entry.projectKey}", "${existing}" e "${scope}" remapeiam para a mesma key "${sanitized}".`,
        );
      } else {
        byProject.set(sanitized, scope);
      }
      targetKeysByProject.set(entry.projectKey, byProject);
    }
  }
}

function validateVariationEntries(
  config: ImportConfig,
  errors: string[],
): void {
  const ignoreScopes = new Set<string>();
  for (const entry of config.variations.ignore) {
    const scope = variationScopeKey(entry);
    if (ignoreScopes.has(scope)) {
      errors.push(`variations.ignore duplicado: ${scope}`);
    }
    ignoreScopes.add(scope);
  }

  const remapScopes = new Set<string>();
  const targetKeys = new Map<string, string>();

  for (const entry of config.variations.remap) {
    const scope = variationScopeKey(entry);
    if (remapScopes.has(scope)) {
      errors.push(`variations.remap duplicado: ${scope}`);
    }
    remapScopes.add(scope);

    if (ignoreScopes.has(scope)) {
      errors.push(
        `variations: ${scope} não pode estar em ignore e remap ao mesmo tempo.`,
      );
    }

    if (!entry.key && !entry.name) {
      errors.push(
        `variations.remap ${scope}: informe ao menos key ou name.`,
      );
    }

    if (entry.key) {
      const bucketKey = `${entry.projectKey}|${entry.flagKey}|${entry.key}`;
      const existing = targetKeys.get(bucketKey);
      if (existing && existing !== scope) {
        errors.push(
          `variations: "${existing}" e "${scope}" remapeiam para a mesma key "${entry.key}" na mesma flag.`,
        );
      } else {
        targetKeys.set(bucketKey, scope);
      }
    }
  }
}

function normalizeProjects(raw: unknown): ImportConfig["projects"] {
  if (raw === undefined) {
    return { ignore: [], remap: {} };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("projects deve ser um objeto.");
  }
  const obj = raw as Record<string, unknown>;
  const ignore = normalizeStringArray(obj.ignore, "projects.ignore");
  const remapRaw = obj.remap;
  const remap: Record<string, ProjectRemapEntry> = {};

  if (remapRaw !== undefined) {
    if (
      remapRaw === null ||
      typeof remapRaw !== "object" ||
      Array.isArray(remapRaw)
    ) {
      throw new Error("projects.remap deve ser um objeto.");
    }
    for (const [projectKey, value] of Object.entries(
      remapRaw as Record<string, unknown>,
    )) {
      if (!projectKey.trim()) {
        throw new Error("projects.remap não pode ter chave vazia.");
      }
      remap[projectKey] = normalizeProjectRemapEntry(
        value,
        `projects.remap["${projectKey}"]`,
      );
    }
  }

  return { ignore, remap };
}

function normalizeProjectRemapEntry(
  raw: unknown,
  label: string,
): ProjectRemapEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} deve ser um objeto.`);
  }
  const obj = raw as Record<string, unknown>;
  const entry: ProjectRemapEntry = {};

  if (obj.key !== undefined) {
    entry.key = requireNonEmptyString(obj.key, `${label}.key`);
  }
  if (obj.name !== undefined) {
    entry.name = requireNonEmptyString(obj.name, `${label}.name`);
  }
  if (obj.environmentStrategy !== undefined) {
    entry.environmentStrategy = requireNonEmptyString(
      obj.environmentStrategy,
      `${label}.environmentStrategy`,
    ) as EnvironmentStrategy;
  }
  if (obj.environments !== undefined) {
    entry.environments = normalizeIgnoreRemapSection(
      obj.environments,
      `${label}.environments`,
    );
  }

  return entry;
}

function normalizeIgnoreRemapSection(
  raw: unknown,
  label: string,
): IgnoreRemapSection {
  if (raw === undefined) {
    return { ...EMPTY_IGNORE_REMAP, remap: {} };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} deve ser um objeto.`);
  }
  const obj = raw as Record<string, unknown>;
  const ignore = normalizeStringArray(obj.ignore, `${label}.ignore`);
  const remap: Record<string, KeyNameRemap> = {};

  if (obj.remap !== undefined) {
    if (
      obj.remap === null ||
      typeof obj.remap !== "object" ||
      Array.isArray(obj.remap)
    ) {
      throw new Error(`${label}.remap deve ser um objeto.`);
    }
    for (const [source, value] of Object.entries(
      obj.remap as Record<string, unknown>,
    )) {
      if (!source.trim()) {
        throw new Error(`${label}.remap não pode ter chave vazia.`);
      }
      remap[source] = normalizeKeyNameRemap(value, `${label}.remap["${source}"]`);
    }
  }

  return { ignore, remap };
}

function normalizeKeyNameRemap(raw: unknown, label: string): KeyNameRemap {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} deve ser um objeto.`);
  }
  const obj = raw as Record<string, unknown>;
  const result: KeyNameRemap = {};
  if (obj.key !== undefined) {
    result.key = requireNonEmptyString(obj.key, `${label}.key`);
  }
  if (obj.name !== undefined) {
    result.name = requireNonEmptyString(obj.name, `${label}.name`);
  }
  return result;
}

function normalizeFlags(raw: unknown): ImportConfig["flags"] {
  if (raw === undefined) {
    return { ignore: [], remap: [] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("flags deve ser um objeto.");
  }
  const obj = raw as Record<string, unknown>;
  return {
    ignore: normalizeFlagScopeArray(obj.ignore, "flags.ignore"),
    remap: normalizeFlagRemapArray(obj.remap, "flags.remap"),
  };
}

function normalizeVariations(raw: unknown): ImportConfig["variations"] {
  if (raw === undefined) {
    return { ignore: [], remap: [] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("variations deve ser um objeto.");
  }
  const obj = raw as Record<string, unknown>;
  return {
    ignore: normalizeVariationScopeArray(obj.ignore, "variations.ignore"),
    remap: normalizeVariationRemapArray(obj.remap, "variations.remap"),
  };
}

function normalizeFlagScopeArray(raw: unknown, label: string): FlagScope[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} deve ser um array.`);
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] deve ser um objeto.`);
    }
    const obj = item as Record<string, unknown>;
    return {
      projectKey: requireNonEmptyString(
        obj.projectKey,
        `${label}[${index}].projectKey`,
      ),
      flagKey: requireNonEmptyString(obj.flagKey, `${label}[${index}].flagKey`),
    };
  });
}

function normalizeFlagRemapArray(
  raw: unknown,
  label: string,
): FlagRemapEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} deve ser um array.`);
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] deve ser um objeto.`);
    }
    const obj = item as Record<string, unknown>;
    const entry: FlagRemapEntry = {
      projectKey: requireNonEmptyString(
        obj.projectKey,
        `${label}[${index}].projectKey`,
      ),
      flagKey: requireNonEmptyString(obj.flagKey, `${label}[${index}].flagKey`),
    };
    if (obj.key !== undefined) {
      entry.key = requireNonEmptyString(obj.key, `${label}[${index}].key`);
    }
    if (obj.name !== undefined) {
      entry.name = requireNonEmptyString(obj.name, `${label}[${index}].name`);
    }
    return entry;
  });
}

function normalizeVariationScopeArray(
  raw: unknown,
  label: string,
): VariationScope[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} deve ser um array.`);
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] deve ser um objeto.`);
    }
    const obj = item as Record<string, unknown>;
    return {
      projectKey: requireNonEmptyString(
        obj.projectKey,
        `${label}[${index}].projectKey`,
      ),
      flagKey: requireNonEmptyString(obj.flagKey, `${label}[${index}].flagKey`),
      variationId: requireNonEmptyString(
        obj.variationId,
        `${label}[${index}].variationId`,
      ),
    };
  });
}

function normalizeVariationRemapArray(
  raw: unknown,
  label: string,
): VariationRemapEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} deve ser um array.`);
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] deve ser um objeto.`);
    }
    const obj = item as Record<string, unknown>;
    const entry: VariationRemapEntry = {
      projectKey: requireNonEmptyString(
        obj.projectKey,
        `${label}[${index}].projectKey`,
      ),
      flagKey: requireNonEmptyString(obj.flagKey, `${label}[${index}].flagKey`),
      variationId: requireNonEmptyString(
        obj.variationId,
        `${label}[${index}].variationId`,
      ),
    };
    if (obj.key !== undefined) {
      entry.key = requireNonEmptyString(obj.key, `${label}[${index}].key`);
    }
    if (obj.name !== undefined) {
      entry.name = requireNonEmptyString(obj.name, `${label}[${index}].name`);
    }
    return entry;
  });
}

function normalizeStringArray(raw: unknown, label: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} deve ser um array de strings.`);
  }
  return raw.map((item, index) =>
    requireNonEmptyString(item, `${label}[${index}]`),
  );
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} deve ser uma string não vazia.`);
  }
  return value.trim();
}

function isValidGbKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function sanitizeGbKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function flagScopeKey(entry: FlagScope): string {
  return `${entry.projectKey}/${entry.flagKey}`;
}

function variationScopeKey(entry: VariationScope): string {
  return `${entry.projectKey}/${entry.flagKey}/${entry.variationId}`;
}

export function summarizeImportConfig(config: ImportConfig): Record<string, unknown> {
  return {
    projectsIgnored: config.projects.ignore.length,
    projectsRemapped: Object.keys(config.projects.remap).length,
    environmentsIgnored: config.environments.ignore.length,
    environmentsRemapped: Object.keys(config.environments.remap).length,
    flagsIgnored: config.flags.ignore.length,
    flagsRemapped: config.flags.remap.length,
    variationsIgnored: config.variations.ignore.length,
    variationsRemapped: config.variations.remap.length,
    uniqueEnvironmentProjects: Object.entries(config.projects.remap).filter(
      ([, entry]) => entry.environmentStrategy === "unique",
    ).length,
  };
}
