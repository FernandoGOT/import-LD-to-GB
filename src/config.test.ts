import { describe, expect, it } from "vitest";
import {
  assertNoEnvironmentConflicts,
  buildEffectiveEnvKeyMap,
  collectPlannedEnvironmentTargets,
  emptyImportConfig,
  filterAndRemapVariations,
  getEnvironmentStrategy,
  isFlagIgnored,
  isProjectIgnored,
  isVariationIgnored,
  normalizeImportConfig,
  remapFlag,
  remapProject,
  remapVariation,
  resolveEffectiveEnvironmentTarget,
  resolveFlagKey,
  resolveVariationSourceId,
  validateImportConfig,
  type ImportConfig,
} from "./config.js";
import { applyNamingConvention } from "./naming.js";

function validBase(): ImportConfig {
  return normalizeImportConfig({
    projects: {
      remap: {
        "app-shared": { environmentStrategy: "shared" },
        "app-unique": {
          environmentStrategy: "unique",
          environments: {
            remap: {
              production: { key: "app-unique-prod", name: "Unique Prod" },
            },
          },
        },
      },
    },
    environments: {
      remap: {
        production: { key: "prod", name: "Production" },
      },
    },
  });
}

describe("normalizeImportConfig / validateImportConfig", () => {
  it("accepts empty object as empty config", () => {
    const config = normalizeImportConfig({});
    expect(config).toEqual(emptyImportConfig());
    expect(() => validateImportConfig(config)).not.toThrow();
  });

  it("rejects non-object root", () => {
    expect(() => normalizeImportConfig([])).toThrow(/objeto JSON/);
  });

  it("rejects unknown top-level section", () => {
    expect(() => normalizeImportConfig({ foo: {} })).toThrow(/desconhecida/);
  });

  it("rejects project in both ignore and remap", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          projects: {
            ignore: ["a"],
            remap: { a: { name: "A" } },
          },
        }),
      ),
    ).toThrow(/ignore e remap/);
  });

  it("rejects invalid environmentStrategy", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          projects: {
            remap: { a: { environmentStrategy: "hybrid" } },
          },
        }),
      ),
    ).toThrow(/environmentStrategy inválida/);
  });

  it("rejects flag entry without projectKey", () => {
    expect(() =>
      normalizeImportConfig({
        flags: {
          ignore: [{ flagKey: "x" }],
        },
      }),
    ).toThrow(/projectKey/);
  });

  it("rejects variation entry without variationId", () => {
    expect(() =>
      normalizeImportConfig({
        variations: {
          ignore: [{ projectKey: "p", flagKey: "f" }],
        },
      }),
    ).toThrow(/variationId/);
  });

  it("rejects flag in ignore and remap for same scope", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          flags: {
            ignore: [{ projectKey: "p", flagKey: "f" }],
            remap: [{ projectKey: "p", flagKey: "f", name: "F" }],
          },
        }),
      ),
    ).toThrow(/ignore e remap/);
  });

  it("rejects two flags in same project remapping to same key", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          flags: {
            remap: [
              { projectKey: "p", flagKey: "a", key: "same" },
              { projectKey: "p", flagKey: "b", key: "same" },
            ],
          },
        }),
      ),
    ).toThrow(/mesma key/);
  });

  it("allows same flag key remap in different projects", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          flags: {
            remap: [
              { projectKey: "p1", flagKey: "a", key: "same" },
              { projectKey: "p2", flagKey: "a", key: "same" },
            ],
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects invalid remapped environment key charset", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          environments: {
            remap: { production: { key: "prod env" } },
          },
        }),
      ),
    ).toThrow(/key inválida/);
  });
});

describe("environment conflict validation", () => {
  it("rejects unique env id colliding with shared env id", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          environments: {
            remap: { production: { key: "prod", name: "Production" } },
          },
          projects: {
            remap: {
              "app-b": {
                environmentStrategy: "unique",
                environments: {
                  remap: {
                    production: { key: "prod", name: "Other Prod" },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toThrow(/environment id "prod"/);
  });

  it("rejects unique env name colliding with shared env name", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          environments: {
            remap: { production: { key: "prod", name: "Production" } },
          },
          projects: {
            remap: {
              "app-b": {
                environmentStrategy: "unique",
                environments: {
                  remap: {
                    production: {
                      key: "app-b-prod",
                      name: "Production",
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toThrow(/environment name "production"/);
  });

  it("rejects two unique projects mapping to the same env id", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          projects: {
            remap: {
              "app-a": {
                environmentStrategy: "unique",
                environments: {
                  remap: {
                    production: { key: "collision", name: "A" },
                  },
                },
              },
              "app-b": {
                environmentStrategy: "unique",
                environments: {
                  remap: {
                    production: { key: "collision", name: "B" },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toThrow(/environment id "collision"/);
  });

  it("rejects shared remaps colliding on target key", () => {
    expect(() =>
      validateImportConfig(
        normalizeImportConfig({
          environments: {
            remap: {
              production: { key: "same" },
              staging: { key: "same" },
            },
          },
        }),
      ),
    ).toThrow(/mesma key "same"/);
  });

  it("accepts valid shared + unique without collisions", () => {
    expect(() => validateImportConfig(validBase())).not.toThrow();
  });

  it("detects unique remap colliding with shared LD key from real envs", () => {
    const config = normalizeImportConfig({
      projects: {
        remap: {
          "app-shared": { environmentStrategy: "shared" },
          "app-unique": {
            environmentStrategy: "unique",
            environments: {
              remap: {
                production: { key: "prod", name: "Unique Prod" },
              },
            },
          },
        },
      },
    });

    const ldEnvsByProject = new Map([
      ["app-shared", [{ key: "prod", name: "Prod" }]],
      ["app-unique", [{ key: "production", name: "Production" }]],
    ]);

    expect(() =>
      assertNoEnvironmentConflicts(config, ldEnvsByProject),
    ).toThrow(/environment id "prod"/);
  });

  it("detects auto-prefixed unique id colliding with shared target", () => {
    const config = normalizeImportConfig({
      environments: {
        remap: {
          production: { key: "app-unique__production", name: "Shared" },
        },
      },
      projects: {
        remap: {
          "app-shared": { environmentStrategy: "shared" },
          "app-unique": { environmentStrategy: "unique" },
        },
      },
    });

    const ldEnvsByProject = new Map([
      ["app-shared", [{ key: "production", name: "Production" }]],
      ["app-unique", [{ key: "production", name: "Production" }]],
    ]);

    expect(() =>
      assertNoEnvironmentConflicts(config, ldEnvsByProject),
    ).toThrow(/app-unique__production/);
  });
});

describe("environment strategy helpers", () => {
  it("defaults strategy to shared", () => {
    const config = emptyImportConfig();
    expect(getEnvironmentStrategy(config, "any")).toBe("shared");
  });

  it("resolves shared remap and unique remap/prefix", () => {
    const config = validBase();

    expect(
      resolveEffectiveEnvironmentTarget(config, "app-shared", {
        key: "production",
        name: "Production",
      }),
    ).toEqual({ key: "prod", name: "Production" });

    expect(
      resolveEffectiveEnvironmentTarget(config, "app-unique", {
        key: "production",
        name: "Production",
      }),
    ).toEqual({ key: "app-unique-prod", name: "Unique Prod" });

    expect(
      resolveEffectiveEnvironmentTarget(config, "app-unique", {
        key: "staging",
        name: "Staging",
      }),
    ).toEqual({ key: "app-unique__staging", name: "Staging" });
  });

  it("builds effective env key map skipping ignored envs", () => {
    const config = normalizeImportConfig({
      environments: {
        ignore: ["test"],
        remap: { production: { key: "prod" } },
      },
    });

    const map = buildEffectiveEnvKeyMap(config, "app", [
      { key: "production", name: "Production" },
      { key: "test", name: "Test" },
    ]);

    expect([...map.entries()]).toEqual([["production", "prod"]]);
  });

  it("plans distinct targets for shared and unique projects", () => {
    const config = validBase();
    const ldEnvsByProject = new Map([
      ["app-shared", [{ key: "production", name: "Production" }]],
      ["app-unique", [{ key: "production", name: "Production" }]],
    ]);

    const targets = collectPlannedEnvironmentTargets(config, ldEnvsByProject);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "shared",
          key: "prod",
          name: "Production",
        }),
        expect.objectContaining({
          origin: "unique:app-unique",
          key: "app-unique-prod",
          name: "Unique Prod",
        }),
      ]),
    );
  });
});

describe("project / flag / variation helpers", () => {
  it("ignores and remaps projects", () => {
    const config = normalizeImportConfig({
      projects: {
        ignore: ["skip"],
        remap: { keep: { key: "kept", name: "Kept" } },
      },
    });

    expect(isProjectIgnored(config, "skip")).toBe(true);
    expect(remapProject(config, "keep", { key: "keep", name: "Old" })).toEqual(
      { key: "kept", name: "Kept" },
    );
  });

  it("scopes flag ignore/remap by projectKey + flagKey", () => {
    const config = normalizeImportConfig({
      flags: {
        ignore: [{ projectKey: "p1", flagKey: "f" }],
        remap: [
          { projectKey: "p2", flagKey: "f", key: "f2", name: "Flag Two" },
        ],
      },
    });

    expect(isFlagIgnored(config, "p1", "f")).toBe(true);
    expect(isFlagIgnored(config, "p2", "f")).toBe(false);
    expect(remapFlag(config, "p2", "f", { key: "f", name: "F" })).toEqual({
      key: "f2",
      name: "Flag Two",
    });
    expect(remapFlag(config, "p1", "f", { key: "f", name: "F" })).toEqual({
      key: "f",
      name: "F",
    });
  });

  it("resolves variation ids by key, _id, then index", () => {
    expect(resolveVariationSourceId({ key: "k" }, 0)).toBe("k");
    expect(resolveVariationSourceId({ _id: "id1" }, 0)).toBe("id1");
    expect(resolveVariationSourceId({ id: "id2" }, 0)).toBe("id2");
    expect(resolveVariationSourceId({}, 3)).toBe("3");
  });

  it("ignores/remaps variations only for matching project+flag+variationId", () => {
    const config = normalizeImportConfig({
      variations: {
        ignore: [
          { projectKey: "p1", flagKey: "f1", variationId: "control" },
        ],
        remap: [
          {
            projectKey: "p1",
            flagKey: "f1",
            variationId: "treatment",
            name: "Variant A",
          },
          {
            projectKey: "p2",
            flagKey: "f1",
            variationId: "treatment",
            name: "Variant B",
          },
        ],
      },
    });

    expect(
      isVariationIgnored(config, "p1", "f1", { key: "control" }, 0),
    ).toBe(true);
    expect(
      isVariationIgnored(config, "p2", "f1", { key: "control" }, 0),
    ).toBe(false);

    expect(
      remapVariation(config, "p1", "f1", { key: "treatment", name: "T" }, 1),
    ).toEqual({ key: "treatment", name: "Variant A" });
    expect(
      remapVariation(config, "p2", "f1", { key: "treatment", name: "T" }, 1),
    ).toEqual({ key: "treatment", name: "Variant B" });
  });

  it("filters and remaps variations without leaking across flags", () => {
    const config = normalizeImportConfig({
      variations: {
        ignore: [{ projectKey: "p", flagKey: "f1", variationId: "0" }],
        remap: [
          {
            projectKey: "p",
            flagKey: "f1",
            variationId: "1",
            name: "Renamed",
          },
        ],
      },
    });

    const result = filterAndRemapVariations(config, "p", "f1", [
      { name: "Control", value: false },
      { name: "Treatment", value: true },
    ]);

    expect(result).toEqual([{ name: "Renamed", value: true }]);

    const otherFlag = filterAndRemapVariations(config, "p", "f2", [
      { name: "Control", value: false },
      { name: "Treatment", value: true },
    ]);
    expect(otherFlag).toHaveLength(2);
    expect(otherFlag[0]?.name).toBe("Control");
  });
});

describe("flag naming convention", () => {
  it("defaults namingConvention to kebab-case", () => {
    expect(emptyImportConfig().flags.namingConvention).toBe("kebab-case");
    expect(normalizeImportConfig({}).flags.namingConvention).toBe("kebab-case");
    expect(normalizeImportConfig({ flags: {} }).flags.namingConvention).toBe(
      "kebab-case",
    );
  });

  it("rejects invalid namingConvention", () => {
    expect(() =>
      normalizeImportConfig({ flags: { namingConvention: "Title Case" } }),
    ).toThrow(/namingConvention inválida/);
  });

  it("transforms common LD key styles to kebab-case", () => {
    expect(applyNamingConvention("RolloutHomeBetAgain", "kebab-case")).toBe(
      "rollout-home-bet-again",
    );
    expect(applyNamingConvention("configureCartCrossSell", "kebab-case")).toBe(
      "configure-cart-cross-sell",
    );
    expect(
      applyNamingConvention(
        "allow-check-if-user-should-see-promotions-carousel",
        "kebab-case",
      ),
    ).toBe("allow-check-if-user-should-see-promotions-carousel");
    expect(applyNamingConvention("XMLParser", "kebab-case")).toBe("xml-parser");
    expect(applyNamingConvention("foo_bar", "kebab-case")).toBe("foo-bar");
  });

  it("supports other conventions and preserve", () => {
    expect(applyNamingConvention("RolloutHomeBetAgain", "snake_case")).toBe(
      "rollout_home_bet_again",
    );
    expect(applyNamingConvention("rollout-home-bet-again", "camelCase")).toBe(
      "rolloutHomeBetAgain",
    );
    expect(applyNamingConvention("rollout-home-bet-again", "PascalCase")).toBe(
      "RolloutHomeBetAgain",
    );
    expect(applyNamingConvention("RolloutHomeBetAgain", "preserve")).toBe(
      "RolloutHomeBetAgain",
    );
  });

  it("resolveFlagKey applies convention then sanitize", () => {
    const config = normalizeImportConfig({});
    expect(resolveFlagKey(config, "p", "configureCartCrossSell")).toBe(
      "configure-cart-cross-sell",
    );
    expect(resolveFlagKey(config, "p", "flag.with.dots")).toBe(
      "flag_with_dots",
    );
  });

  it("resolveFlagKey respects preserve mode", () => {
    const config = normalizeImportConfig({
      flags: { namingConvention: "preserve" },
    });
    expect(resolveFlagKey(config, "p", "configureCartCrossSell")).toBe(
      "configureCartCrossSell",
    );
  });

  it("explicit remap key skips naming convention", () => {
    const config = normalizeImportConfig({
      flags: {
        namingConvention: "kebab-case",
        remap: [
          {
            projectKey: "p",
            flagKey: "configureCartCrossSell",
            key: "CartCrossSell",
          },
        ],
      },
    });
    expect(resolveFlagKey(config, "p", "configureCartCrossSell")).toBe(
      "CartCrossSell",
    );
  });

  it("remap that only sets name still applies naming convention to key", () => {
    const config = normalizeImportConfig({
      flags: {
        namingConvention: "kebab-case",
        remap: [
          {
            projectKey: "p",
            flagKey: "configureCartCrossSell",
            name: "Cart cross sell",
          },
        ],
      },
    });
    expect(resolveFlagKey(config, "p", "configureCartCrossSell")).toBe(
      "configure-cart-cross-sell",
    );
  });

  it("detects that PascalCase and kebab-case LD keys collide under kebab-case", () => {
    const config = normalizeImportConfig({
      flags: { namingConvention: "kebab-case" },
    });
    expect(resolveFlagKey(config, "p", "FooBar")).toBe("foo-bar");
    expect(resolveFlagKey(config, "p", "foo-bar")).toBe("foo-bar");
  });
});
