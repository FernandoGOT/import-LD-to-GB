import { delay, requestJson } from "./http.js";
import {
  ensureRulesAndVariationsFromFlags,
  readEnvironmentsForProject,
  readFlagsForProject,
  readProjectsCache,
  readSegmentsForEnv,
  resolveLdCacheDir,
  writeEnvironmentsForProject,
  writeFlagsForProject,
  writeProjectsCache,
  writeSegmentsForEnv,
} from "./ld-cache.js";
import type {
  LaunchDarklyEnvironment,
  LaunchDarklyFlagDetail,
  LaunchDarklyProject,
  LaunchDarklySegment,
} from "../types/migrate.js";

export type LdClientConfig = {
  baseUrl: string;
  token: string;
  apiVersion: string;
  requestDelayMs: number;
  cacheDir?: string;
};

export function createLdClient(config: LdClientConfig) {
  const cacheDir = resolveLdCacheDir(config.cacheDir);

  async function ldGet<T>(path: string): Promise<T> {
    return requestJson<T>(`${config.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: config.token,
        "LD-API-Version": config.apiVersion,
      },
    });
  }

  async function listProjects(): Promise<LaunchDarklyProject[]> {
    const cached = await readProjectsCache(cacheDir);
    if (cached) return cached;

    const items: LaunchDarklyProject[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await ldGet<{
        items?: LaunchDarklyProject[];
        totalCount?: number;
      }>(`/projects?limit=${limit}&offset=${offset}`);

      const pageItems = response.items ?? [];
      items.push(...pageItems);

      if (pageItems.length < limit) break;
      if (
        typeof response.totalCount === "number" &&
        items.length >= response.totalCount
      ) {
        break;
      }

      offset += limit;
      await delay(config.requestDelayMs);
    }

    await writeProjectsCache(cacheDir, items);
    return items;
  }

  async function listEnvironments(
    projectKey: string,
  ): Promise<LaunchDarklyEnvironment[]> {
    const cached = await readEnvironmentsForProject(cacheDir, projectKey);
    if (cached) return cached;

    const items: LaunchDarklyEnvironment[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await ldGet<{
        items?: LaunchDarklyEnvironment[];
        totalCount?: number;
      }>(
        `/projects/${encodeURIComponent(projectKey)}/environments?limit=${limit}&offset=${offset}`,
      );

      const pageItems = response.items ?? [];
      items.push(...pageItems);

      if (pageItems.length < limit) break;
      if (
        typeof response.totalCount === "number" &&
        items.length >= response.totalCount
      ) {
        break;
      }

      offset += limit;
      await delay(config.requestDelayMs);
    }

    await writeEnvironmentsForProject(cacheDir, projectKey, items);
    return items;
  }

  async function listFlags(
    projectKey: string,
    environmentKeys: string[] = [],
  ): Promise<LaunchDarklyFlagDetail[]> {
    const cached = await readFlagsForProject(cacheDir, projectKey);
    if (cached) {
      await ensureRulesAndVariationsFromFlags(cacheDir, projectKey, cached);
      return cached;
    }

    const items: LaunchDarklyFlagDetail[] = [];
    let offset = 0;
    const limit = 100;
    // LD omits per-environment targeting unless summary=0 AND env=... are set.
    const envQuery = environmentKeys
      .filter((key) => key.trim().length > 0)
      .map((key) => `&env=${encodeURIComponent(key)}`)
      .join("");

    while (true) {
      const path =
        `/flags/${encodeURIComponent(projectKey)}` +
        `?summary=0&limit=${limit}&offset=${offset}${envQuery}`;

      const response = await ldGet<{
        items?: LaunchDarklyFlagDetail[];
        totalCount?: number;
      }>(path);

      const pageItems = response.items ?? [];
      items.push(...pageItems);

      if (pageItems.length < limit) break;
      if (
        typeof response.totalCount === "number" &&
        items.length >= response.totalCount
      ) {
        break;
      }

      offset += limit;
      await delay(config.requestDelayMs);
    }

    await writeFlagsForProject(cacheDir, projectKey, items);
    return items;
  }

  async function listSegments(
    projectKey: string,
    environmentKey: string,
  ): Promise<LaunchDarklySegment[]> {
    const cached = await readSegmentsForEnv(
      cacheDir,
      projectKey,
      environmentKey,
    );
    if (cached) return cached;

    const items: LaunchDarklySegment[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const path =
        `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(environmentKey)}` +
        `?limit=${limit}&offset=${offset}`;

      const response = await ldGet<{
        items?: LaunchDarklySegment[];
        totalCount?: number;
      }>(path);

      const pageItems = response.items ?? [];
      items.push(...pageItems);

      if (pageItems.length < limit) break;
      if (
        typeof response.totalCount === "number" &&
        items.length >= response.totalCount
      ) {
        break;
      }

      offset += limit;
      await delay(config.requestDelayMs);
    }

    await writeSegmentsForEnv(cacheDir, projectKey, environmentKey, items);
    return items;
  }

  return {
    listProjects,
    listEnvironments,
    listFlags,
    listSegments,
  };
}

export type LdClient = ReturnType<typeof createLdClient>;
