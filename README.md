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
```

Edite o `.env` com seus tokens.

## Migração completa (`npm run migrate`)

Substitui o import nativo do GrowthBook com um pipeline controlado:

1. **Projetos** — match (`auto`/`json`) ou cria (`publicId` = LD key)
2. **Ambientes** — cria ambientes org-level no GB com o mesmo `key` do LD
3. **Segmentos** — LD segments → GB saved groups (`list` ou `condition`), nome `{project}:{env}:{segmentKey}`
4. **Features + regras** — cria/atualiza features; importa targets, rules, fallthrough/rollout e prerequisites
5. **Variações** — backfill das variações faltantes como `force` desativadas (mesma lógica do `sync`)

Todas as regras de targeting/rollout/variação importadas ficam com `enabled: false` para revisão segura no GrowthBook.

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
| `MIGRATE_IMPORT_TARGETING` | `true` | Importa targets/rules/fallthrough |
| `MIGRATE_IMPORT_VARIATIONS` | `true` | Backfill de variações como force desativadas |
| `SEGMENT_LIST_ATTRIBUTE_KEY` | `id` | Atributo usado em saved groups tipo `list` |
| `GB_FEATURE_OWNER` | `ld-migrate` | Valor de `owner` no `POST /features` (exigido no GB self-hosted) |

### Limitações

- Regras importadas **não** são ativadas automaticamente
- Big/synced/unbounded segments LD → `unsupported` no relatório
- Operadores LD sem equivalente Mongo no GB → warning `unsupported` (a rule pode ser omitida/parcial)
- Experimentos LD / progressive / guarded rollouts não viram entidades Experiment do GB
- SDK connections e catálogo de attributes no GB ficam manuais

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

## Testes

```bash
npm test
```

Cobertura: dedupe de variações, clauses→conditions, segments→saved groups, rules/rollouts desativados, match de projetos/ambientes e idempotência de ids de importação.
