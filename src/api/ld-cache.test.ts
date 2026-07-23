import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLdClient } from "./ld-client.js";
import {
  cachePath,
  extractRulesFromFlags,
  extractVariationsFromFlags,
  fileExists,
} from "./ld-cache.js";
import type { LaunchDarklyFlagDetail } from "../types/migrate.js";

const sampleFlags: LaunchDarklyFlagDetail[] = [
  {
    key: "checkout",
    name: "Checkout",
    variations: [
      { _id: "v0", value: false, name: "off" },
      { _id: "v1", value: true, name: "on" },
    ],
    environments: {
      production: {
        on: true,
        rules: [
          {
            _id: "rule-1",
            clauses: [
              {
                attribute: "email",
                op: "endsWith",
                values: ["@example.com"],
                negate: false,
              },
            ],
            variation: 1,
          },
        ],
      },
      staging: {
        on: false,
        rules: [],
      },
    },
  },
];

describe("ld-cache extract helpers", () => {
  it("extracts rules and variations from flags", () => {
    const rules = extractRulesFromFlags("proj-a", sampleFlags);
    const variations = extractVariationsFromFlags("proj-a", sampleFlags);

    expect(rules["proj-a"]?.checkout?.production).toHaveLength(1);
    expect(rules["proj-a"]?.checkout?.staging).toEqual([]);
    expect(variations["proj-a"]?.checkout).toHaveLength(2);
  });
});

describe("createLdClient file cache", () => {
  let cacheDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "ld-cache-test-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(cacheDir, { recursive: true, force: true });
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function createClient() {
    return createLdClient({
      baseUrl: "https://ld.test/api/v2",
      token: "test-token",
      apiVersion: "20240415",
      requestDelayMs: 0,
      cacheDir,
    });
  }

  it("caches projects on first call and skips network on second", async () => {
    const projects = [{ key: "proj-a", name: "Project A" }];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: projects, totalCount: 1 }),
    );

    const ld = createClient();
    const first = await ld.listProjects();
    const second = await ld.listProjects();

    expect(first).toEqual(projects);
    expect(second).toEqual(projects);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fileExists(cachePath(cacheDir, "projects"))).toBe(true);
  });

  it("caches environments keyed by project", async () => {
    const envsA = [{ key: "production", name: "Production" }];
    const envsB = [{ key: "staging", name: "Staging" }];

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: envsA, totalCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ items: envsB, totalCount: 1 }));

    const ld = createClient();
    expect(await ld.listEnvironments("proj-a")).toEqual(envsA);
    expect(await ld.listEnvironments("proj-b")).toEqual(envsB);
    expect(await ld.listEnvironments("proj-a")).toEqual(envsA);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const raw = await readFile(cachePath(cacheDir, "environments"), "utf8");
    const cached = JSON.parse(raw) as Record<string, unknown>;
    expect(cached["proj-a"]).toEqual(envsA);
    expect(cached["proj-b"]).toEqual(envsB);
  });

  it("caches flags and writes rules/variations extracts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: sampleFlags, totalCount: 1 }),
    );

    const ld = createClient();
    const first = await ld.listFlags("proj-a", ["production", "staging"]);
    const second = await ld.listFlags("proj-a", ["production", "staging"]);

    expect(first).toEqual(sampleFlags);
    expect(second).toEqual(sampleFlags);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await fileExists(cachePath(cacheDir, "flags"))).toBe(true);
    expect(await fileExists(cachePath(cacheDir, "rules"))).toBe(true);
    expect(await fileExists(cachePath(cacheDir, "variations"))).toBe(true);

    const rules = JSON.parse(
      await readFile(cachePath(cacheDir, "rules"), "utf8"),
    ) as ReturnType<typeof extractRulesFromFlags>;
    const variations = JSON.parse(
      await readFile(cachePath(cacheDir, "variations"), "utf8"),
    ) as ReturnType<typeof extractVariationsFromFlags>;

    expect(rules["proj-a"]?.checkout?.production).toHaveLength(1);
    expect(variations["proj-a"]?.checkout).toHaveLength(2);
  });

  it("caches segments keyed by project and environment", async () => {
    const segments = [{ key: "beta-users", name: "Beta Users" }];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: segments, totalCount: 1 }),
    );

    const ld = createClient();
    const first = await ld.listSegments("proj-a", "production");
    const second = await ld.listSegments("proj-a", "production");

    expect(first).toEqual(segments);
    expect(second).toEqual(segments);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const raw = await readFile(cachePath(cacheDir, "segments"), "utf8");
    const cached = JSON.parse(raw) as Record<
      string,
      Record<string, unknown>
    >;
    expect(cached["proj-a"]?.production).toEqual(segments);
  });
});
