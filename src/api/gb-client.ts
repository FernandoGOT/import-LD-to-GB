import { delay, requestJson } from "./http.js";
import type {
  CreateFeaturePayload,
  GrowthBookEnvironment,
  GrowthBookFeature,
  GrowthBookProject,
  GrowthBookRule,
  GrowthBookSavedGroup,
  SavedGroupCreatePayload,
} from "../types/migrate.js";

export type GbClientConfig = {
  apiBaseUrl: string;
  featuresApiBaseUrl: string;
  apiKey: string;
  requestDelayMs: number;
};

export function createGbClient(config: GbClientConfig) {
  async function gbGet<T>(path: string): Promise<T> {
    return requestJson<T>(`${config.apiBaseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  }

  async function gbPost<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(`${config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function gbFeaturesGet<T>(path: string): Promise<T> {
    return requestJson<T>(`${config.featuresApiBaseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  }

  async function gbFeaturesPost<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(`${config.featuresApiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function listProjects(): Promise<GrowthBookProject[]> {
    const projects: GrowthBookProject[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await gbGet<{
        projects?: GrowthBookProject[];
        hasMore?: boolean;
        nextOffset?: number;
      }>(`/projects?limit=${limit}&offset=${offset}`);

      projects.push(...(response.projects ?? []));

      if (!response.hasMore) break;

      offset = response.nextOffset ?? offset + limit;
      await delay(config.requestDelayMs);
    }

    return projects;
  }

  async function createProject(body: {
    name: string;
    publicId?: string;
    description?: string;
  }): Promise<GrowthBookProject> {
    const response = await gbPost<{ project: GrowthBookProject }>(
      "/projects",
      body,
    );
    return response.project;
  }

  async function listEnvironments(): Promise<GrowthBookEnvironment[]> {
    const response = await gbGet<{
      environments?: GrowthBookEnvironment[];
    }>("/environments");

    return response.environments ?? [];
  }

  async function createEnvironment(body: {
    id: string;
    description?: string;
    projects?: string[];
    defaultState?: boolean;
    toggleOnList?: boolean;
  }): Promise<GrowthBookEnvironment> {
    const response = await gbPost<{ environment: GrowthBookEnvironment }>(
      "/environments",
      body,
    );
    return response.environment;
  }

  async function listSavedGroups(): Promise<GrowthBookSavedGroup[]> {
    const groups: GrowthBookSavedGroup[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await gbGet<{
        savedGroups?: GrowthBookSavedGroup[];
        hasMore?: boolean;
        nextOffset?: number;
      }>(`/saved-groups?limit=${limit}&offset=${offset}`);

      groups.push(...(response.savedGroups ?? []));

      if (!response.hasMore) break;

      offset = response.nextOffset ?? offset + limit;
      await delay(config.requestDelayMs);
    }

    return groups;
  }

  async function createSavedGroup(
    body: SavedGroupCreatePayload,
  ): Promise<GrowthBookSavedGroup> {
    const response = await gbPost<{ savedGroup: GrowthBookSavedGroup }>(
      "/saved-groups",
      body,
    );
    return response.savedGroup;
  }

  async function listFeatures(projectId: string): Promise<GrowthBookFeature[]> {
    const features: GrowthBookFeature[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await gbFeaturesGet<{
        features?: GrowthBookFeature[];
        hasMore?: boolean;
        nextOffset?: number;
      }>(
        `/features?projectId=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`,
      );

      features.push(...(response.features ?? []));

      if (!response.hasMore) break;

      offset = response.nextOffset ?? offset + limit;
      await delay(config.requestDelayMs);
    }

    return features;
  }

  async function createFeature(
    body: CreateFeaturePayload,
  ): Promise<GrowthBookFeature> {
    const response = await gbFeaturesPost<{ feature: GrowthBookFeature }>(
      "/features",
      body,
    );
    return response.feature;
  }

  async function updateFeature(
    featureId: string,
    body: {
      rules?: GrowthBookRule[];
      environments?: Record<string, { enabled?: boolean }>;
      defaultValue?: string;
      description?: string;
      prerequisites?: string[];
      archived?: boolean;
    },
  ): Promise<GrowthBookFeature> {
    const response = await gbFeaturesPost<{ feature: GrowthBookFeature }>(
      `/features/${encodeURIComponent(featureId)}`,
      body,
    );
    return response.feature;
  }

  return {
    listProjects,
    createProject,
    listEnvironments,
    createEnvironment,
    listSavedGroups,
    createSavedGroup,
    listFeatures,
    createFeature,
    updateFeature,
  };
}

export type GbClient = ReturnType<typeof createGbClient>;
