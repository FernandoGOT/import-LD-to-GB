import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type {
  LaunchDarklyEnvironment,
  LaunchDarklyFlagDetail,
  LaunchDarklyProject,
  LaunchDarklyRule,
  LaunchDarklySegment,
  LaunchDarklyVariation,
} from "../types/migrate.js";

export const DEFAULT_LD_CACHE_DIR = "ld-cache";

export type EnvironmentsCache = Record<string, LaunchDarklyEnvironment[]>;
export type FlagsCache = Record<string, LaunchDarklyFlagDetail[]>;
export type RulesCache = Record<
  string,
  Record<string, Record<string, LaunchDarklyRule[]>>
>;
export type VariationsCache = Record<
  string,
  Record<string, LaunchDarklyVariation[]>
>;
export type SegmentsCache = Record<
  string,
  Record<string, LaunchDarklySegment[]>
>;

export type LdCacheFile =
  | "projects"
  | "environments"
  | "flags"
  | "rules"
  | "variations"
  | "segments";

export function resolveLdCacheDir(cacheDir?: string): string {
  return cacheDir ?? process.env.LD_CACHE_DIR ?? DEFAULT_LD_CACHE_DIR;
}

export function cachePath(cacheDir: string, name: LdCacheFile): string {
  return path.join(cacheDir, `${name}.json`);
}

export async function ensureCacheDir(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  if (!(await fileExists(filePath))) return null;
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureCacheDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function extractRulesFromFlags(
  projectKey: string,
  flags: LaunchDarklyFlagDetail[],
  existing: RulesCache = {},
): RulesCache {
  const next: RulesCache = { ...existing, [projectKey]: {} };

  for (const flag of flags) {
    const byEnv: Record<string, LaunchDarklyRule[]> = {};
    for (const [envKey, envConfig] of Object.entries(flag.environments ?? {})) {
      byEnv[envKey] = envConfig.rules ?? [];
    }
    next[projectKey][flag.key] = byEnv;
  }

  return next;
}

export function extractVariationsFromFlags(
  projectKey: string,
  flags: LaunchDarklyFlagDetail[],
  existing: VariationsCache = {},
): VariationsCache {
  const next: VariationsCache = { ...existing, [projectKey]: {} };

  for (const flag of flags) {
    next[projectKey][flag.key] = flag.variations ?? [];
  }

  return next;
}

export async function readProjectsCache(
  cacheDir: string,
): Promise<LaunchDarklyProject[] | null> {
  return readJsonIfExists<LaunchDarklyProject[]>(
    cachePath(cacheDir, "projects"),
  );
}

export async function writeProjectsCache(
  cacheDir: string,
  projects: LaunchDarklyProject[],
): Promise<void> {
  await writeJson(cachePath(cacheDir, "projects"), projects);
}

export async function readEnvironmentsForProject(
  cacheDir: string,
  projectKey: string,
): Promise<LaunchDarklyEnvironment[] | null> {
  const all = await readJsonIfExists<EnvironmentsCache>(
    cachePath(cacheDir, "environments"),
  );
  if (!all || !(projectKey in all)) return null;
  return all[projectKey] ?? [];
}

export async function writeEnvironmentsForProject(
  cacheDir: string,
  projectKey: string,
  environments: LaunchDarklyEnvironment[],
): Promise<void> {
  const file = cachePath(cacheDir, "environments");
  const all =
    (await readJsonIfExists<EnvironmentsCache>(file)) ??
    ({} as EnvironmentsCache);
  all[projectKey] = environments;
  await writeJson(file, all);
}

export async function readFlagsForProject(
  cacheDir: string,
  projectKey: string,
): Promise<LaunchDarklyFlagDetail[] | null> {
  const all = await readJsonIfExists<FlagsCache>(cachePath(cacheDir, "flags"));
  if (!all || !(projectKey in all)) return null;
  return all[projectKey] ?? [];
}

export async function writeFlagsForProject(
  cacheDir: string,
  projectKey: string,
  flags: LaunchDarklyFlagDetail[],
): Promise<void> {
  const flagsFile = cachePath(cacheDir, "flags");
  const all =
    (await readJsonIfExists<FlagsCache>(flagsFile)) ?? ({} as FlagsCache);
  all[projectKey] = flags;
  await writeJson(flagsFile, all);

  const rulesFile = cachePath(cacheDir, "rules");
  const existingRules =
    (await readJsonIfExists<RulesCache>(rulesFile)) ?? ({} as RulesCache);
  await writeJson(
    rulesFile,
    extractRulesFromFlags(projectKey, flags, existingRules),
  );

  const variationsFile = cachePath(cacheDir, "variations");
  const existingVariations =
    (await readJsonIfExists<VariationsCache>(variationsFile)) ??
    ({} as VariationsCache);
  await writeJson(
    variationsFile,
    extractVariationsFromFlags(projectKey, flags, existingVariations),
  );
}

export async function ensureRulesAndVariationsFromFlags(
  cacheDir: string,
  projectKey: string,
  flags: LaunchDarklyFlagDetail[],
): Promise<void> {
  const rulesMissing = !(await fileExists(cachePath(cacheDir, "rules")));
  const variationsMissing = !(await fileExists(
    cachePath(cacheDir, "variations"),
  ));
  if (!rulesMissing && !variationsMissing) return;

  if (rulesMissing) {
    const existing =
      (await readJsonIfExists<RulesCache>(cachePath(cacheDir, "rules"))) ??
      ({} as RulesCache);
    await writeJson(
      cachePath(cacheDir, "rules"),
      extractRulesFromFlags(projectKey, flags, existing),
    );
  }

  if (variationsMissing) {
    const existing =
      (await readJsonIfExists<VariationsCache>(
        cachePath(cacheDir, "variations"),
      )) ?? ({} as VariationsCache);
    await writeJson(
      cachePath(cacheDir, "variations"),
      extractVariationsFromFlags(projectKey, flags, existing),
    );
  }
}

export async function readSegmentsForEnv(
  cacheDir: string,
  projectKey: string,
  environmentKey: string,
): Promise<LaunchDarklySegment[] | null> {
  const all = await readJsonIfExists<SegmentsCache>(
    cachePath(cacheDir, "segments"),
  );
  if (!all?.[projectKey] || !(environmentKey in all[projectKey])) return null;
  return all[projectKey][environmentKey] ?? [];
}

export async function writeSegmentsForEnv(
  cacheDir: string,
  projectKey: string,
  environmentKey: string,
  segments: LaunchDarklySegment[],
): Promise<void> {
  const file = cachePath(cacheDir, "segments");
  const all =
    (await readJsonIfExists<SegmentsCache>(file)) ?? ({} as SegmentsCache);
  if (!all[projectKey]) all[projectKey] = {};
  all[projectKey][environmentKey] = segments;
  await writeJson(file, all);
}
