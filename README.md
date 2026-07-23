# LD to GrowthBook

Scripts em Node.js + TypeScript para migrar / sincronizar LaunchDarkly → GrowthBook.

## Comandos

| Comando | Uso |
|---------|-----|
| `npm run migrate` | Migração completa: projetos, ambientes, segmentos→saved groups, features, targeting e variações |
| `npm run sync` | Só backfill de variações LD como regras `force` desativadas em features já existentes |
| `npm test` | Testes Vitest |

## Instalação

```bash
npm install
cp .env.example .env
cp config.example.json config.json
```

Edite o `.env` com seus tokens e, se quiser, o `config.json` com ignore/remap antes de importar.

## Configuração de importação (`config.json`)

Arquivo opcional (default `./config.json`, sobrescrevível com `CONFIG_PATH`). Se o arquivo não existir, o comportamento atual é mantido.

O config é **sempre validado** no início de `migrate` e `sync`. Conflitos abortam a execução antes de qualquer escrita.

### Schema

```json
{
  "projects": {
    "ignore": ["legacy-project"],
    "remap": {
      "ld-project-shared": {
        "key": "shared-app",
        "name": "Shared App",
        "environmentStrategy": "shared"
      },
      "ld-project-unique": {
        "key": "unique-app",
        "name": "Unique App",
        "environmentStrategy": "unique",
        "environments": {
          "ignore": ["test"],
          "remap": {
            "production": { "key": "unique-app-prod", "name": "Unique Prod" }
          }
        }
      }
    }
  },
  "environments": {
    "ignore": ["test"],
    "remap": {
      "production": { "key": "prod", "name": "Production" }
    }
  },
  "flags": {
    "ignore": [{ "projectKey": "ld-project-shared", "flagKey": "old-flag" }],
    "remap": [
      {
        "projectKey": "ld-project-shared",
        "flagKey": "checkout-v1",
        "key": "checkout",
        "name": "Checkout"
      }
    ]
  },
  "variations": {
    "ignore": [
      {
        "projectKey": "ld-project-shared",
        "flagKey": "checkout-v1",
        "variationId": "var-key-deprecated"
      }
    ],
    "remap": [
      {
        "projectKey": "ld-project-shared",
        "flagKey": "checkout-v1",
        "variationId": "var-key-control",
        "key": "control",
        "name": "Baseline"
      }
    ]
  }
}
```

### Projetos e ambientes

| `environmentStrategy` | Comportamento |
|-----------------------|---------------|
| `shared` (default) | Usa ambientes org-level. Ignore/remap vêm de `environments` (top-level). Vários projetos shared compartilham o mesmo `id`. |
| `unique` | Cria ambientes próprios do projeto (`projects: [gbProjectId]`). Ignore/remap vêm de `projects.remap[ldKey].environments`. Sem `remap.key`, o id vira `{projectKey}__{ldEnvKey}`. |

### Flags e variações

- Cada flag exige `projectKey` + `flagKey`.
- Cada variação exige `projectKey` + `flagKey` + `variationId`.
- `variationId`: `variation.key` → `_id`/`id` → índice (`"0"`, `"1"`, …). **Não** use o `name` (pode colidir).

### Validação (sempre)

O loader falha se houver, entre outros:

- mesma fonte em `ignore` e `remap`
- remaps para o mesmo target `key` no mesmo escopo
- **unique ↔ shared** com o mesmo environment `id` ou `name`
- **unique ↔ unique** com o mesmo environment `id` ou `name`
- colisão do prefixo automático `{projectKey}__{ldEnvKey}` com um ambiente shared
- após buscar envs no LD, revalida colisões com as keys reais

Exemplo inválido (unique reutiliza id/name de shared):

```json
{
  "environments": {
    "remap": { "production": { "key": "prod", "name": "Production" } }
  },
  "projects": {
    "remap": {
      "app-b": {
        "environmentStrategy": "unique",
        "environments": {
          "remap": {
            "production": { "key": "prod", "name": "Production" }
          }
        }
      }
    }
  }
}
```

`PROJECT_MAP_JSON` no `.env` continua sendo o mapa LD key → GB project **id** existente. O remap de `config.json` altera key/name usados no create e no match `auto`.

## Migração completa (`npm run migrate`)

1. **Projetos** — match (`auto`/`json`) ou cria (`publicId` = LD key / remapeado)
2. **Ambientes** — shared e/ou unique conforme `config.json`
3. **Segmentos** — LD segments → GB saved groups
4. **Features + regras** — cria/atualiza features; importa targets, rules, fallthrough/rollout e prerequisites
5. **Variações** — backfill das variações faltantes como `force` desativadas (só valores ainda ausentes)

### Como o targeting é mapeado

- A listagem de flags no LD usa `summary=0` + `env=<cada ambiente>` — sem isso a API omite fallthrough/rules e a feature nasce sem regras.
- `environments[env].enabled` no GB = toggle `on` do ambiente no LD.
- `defaultValue` da feature = `offVariation` do LD (valor servido com a flag off).
- Fallthrough / targets / rules / rollouts viram regras top-level **ativas** (`enabled: true`), cada uma com `environments: [...]`.
- Fallthroughs `force` com o **mesmo valor** (e mesma condition vazia) são **consolidados** numa única regra com a união dos ambientes.
- O nome da regra (`description`) usa o `variation.name` do LD (ex.: `enable`, `[STG] enable`, `disable`). Sem nome, cai no fallback `LD fallthrough`.
- Re-migrate substitui cópias legadas de fallthrough (mesmo valor/condition) quando o id muda por rename/consolidação.
- O backfill de variações (`MIGRATE_IMPORT_VARIATIONS`) continua criando `force` **desativadas** só para valores que ainda não existem em default/rules — não é o caminho principal do targeting.

### Primeiro rode em modo seguro

```bash
npm run migrate
```

Por padrão, `DRY_RUN=true`. Revise:

```bash
cat ld-growthbook-migrate-report.json
```

### Aplicar

```env
DRY_RUN=false
REPORT_PATH=./ld-growthbook-migrate-report.json
```

```bash
npm run migrate
```

### Flags de migrate

| Variável | Default | Efeito |
|----------|---------|--------|
| `MIGRATE_CREATE_PROJECTS` | `true` | Cria projetos ausentes |
| `MIGRATE_CREATE_ENVIRONMENTS` | `true` | Cria ambientes ausentes |
| `MIGRATE_CREATE_FEATURES` | `true` | Cria features ausentes |
| `MIGRATE_CREATE_SAVED_GROUPS` | `true` | Cria saved groups a partir de segmentos |
| `MIGRATE_IMPORT_TARGETING` | `true` | Importa targets/rules/fallthrough (regras ativas, consolidadas por valor) |
| `MIGRATE_IMPORT_VARIATIONS` | `true` | Backfill de variações ausentes como force desativadas |
| `SEGMENT_LIST_ATTRIBUTE_KEY` | `id` | Atributo usado em saved groups tipo `list` |
| `GB_FEATURE_OWNER` | `ld-migrate` | Valor de `owner` no `POST /features` |
| `CONFIG_PATH` | `./config.json` | Arquivo de ignore/remap |

### Limitações

- Big/synced/unbounded segments LD → `unsupported` no relatório
- Operadores LD sem equivalente Mongo no GB → warning `unsupported`
- Experimentos LD / progressive / guarded rollouts não viram entidades Experiment do GB
- SDK connections e catálogo de attributes no GB ficam manuais
- Toggle `on` do LD ≠ valor da variation: um ambiente pode estar ligado e ainda assim servir `false` via fallthrough

## Sync de variações (`npm run sync`)

Útil quando projetos/features já existem e você só quer completar variações faltantes.

```bash
npm run sync
```

Relatório padrão: `ld-growthbook-variation-report.json`.

Comportamento de deduplicação:

- idempotente no nível da feature (valor canônico + id `ld-var-...`)
- uma regra `force` desativada por variação, com múltiplos environments
- consolida cópias legadas e expande escopo parcial de environments

Por padrão (`GB_ENV_STRATEGY=existing`) só marca environments que já existem na feature.

## APIs GrowthBook

- **Projects / Environments / Saved Groups**: API v1 (`GB_API_BASE_URL`)
- **Features**: API v2 (`GB_FEATURES_API_BASE_URL`, ou derivado `/api/v1` → `/api/v2`)

A API v2 usa um array top-level `rules`, em que cada regra declara o escopo com `environments: [...]` (ou `allEnvironments`).

## Cache do LaunchDarkly

Para não consumir a cota da API do LD em execuções repetidas, `migrate` e `sync` gravam as respostas em `./ld-cache/` (sobrescrevível com `LD_CACHE_DIR`).

| Arquivo | Conteúdo |
|---------|----------|
| `projects.json` | Lista de projetos |
| `environments.json` | Ambientes por `projectKey` |
| `flags.json` | Flags por `projectKey` (inclui targeting com `summary=0`) |
| `rules.json` | Extrato das rules aninhadas nas flags (não é um endpoint LD separado) |
| `variations.json` | Extrato das variations aninhadas nas flags |
| `segments.json` | Segmentos por `projectKey` + environment |

Comportamento:

1. Se o dado já existir no cache → usa o arquivo e **não** chama a API.
2. Se não existir → faz o request ao LD, salva o JSON e segue.
3. `rules.json` e `variations.json` são derivados de `flags.json` sempre que flags são buscadas (ou lidas do cache sem esses arquivos).

Para forçar dados novos do LD, apague a pasta (ou um arquivo específico):

```bash
rm -rf ld-cache
```

A pasta está no `.gitignore` e não deve ser commitada.

## Testes

```bash
npm test
```

Cobertura: dedupe de variações, clauses→conditions, segments→saved groups, rules/rollouts ativos, consolidação de fallthroughs por valor, nomes de variation na `description`, merge que remove fallthroughs legados, match de projetos/ambientes, config.json (schema, shared/unique, conflitos de id/name), idempotência de ids de importação e cache local das respostas do LaunchDarkly.
