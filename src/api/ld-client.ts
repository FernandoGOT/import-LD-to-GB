import { delay, requestJson } from "./http.js";
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
};

export function createLdClient(config: LdClientConfig) {
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

    return items;
  }

  async function listEnvironments(
    projectKey: string,
  ): Promise<LaunchDarklyEnvironment[]> {
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

    return items;
  }

  async function listFlags(projectKey: string): Promise<LaunchDarklyFlagDetail[]> {
    const items: LaunchDarklyFlagDetail[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const path =
        `/flags/${encodeURIComponent(projectKey)}` +
        `?summary=false&limit=${limit}&offset=${offset}`;

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

    return items;
  }

  async function listSegments(
    projectKey: string,
    environmentKey: string,
  ): Promise<LaunchDarklySegment[]> {
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
