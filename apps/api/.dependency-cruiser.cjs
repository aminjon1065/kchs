/**
 * Границы модулей kchs (02-architecture/01-overview.md).
 *  - modules/* → kernel, shared, packages и modules/<other>/public.ts — и ничего больше
 *  - kernel/*  → не знает о modules/*
 *  - shared/*  → низкоуровневый слой без обратных зависимостей
 *  - таблицы — у владельца (ADR-0178): модуль читает и пишет только свои таблицы,
 *    из таблиц ядра напрямую — реестр объектов; остальное — через сервисы ядра и
 *    публичные API модулей
 *
 * Базы известных нарушений нет (ADR-0184): известные сняты, любое новое роняет
 * `pnpm deps:check`. Запись в таблицы ядра и сырой SQL проверяют скрипты
 * `scripts/table-owners.mjs` и `scripts/raw-sql.mjs` там же.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'kernel-not-depend-on-modules',
      severity: 'error',
      comment:
        'Ядро не знает о модулях: типы объектов попадают в ядро только через реестр при старте.',
      from: { path: '^src/kernel' },
      to: { path: '^src/modules' },
    },
    {
      name: 'modules-only-via-public',
      severity: 'error',
      comment:
        'Модуль обращается к другому модулю только через его public.ts (схему чужого модуля проверяет правило module-tables-owned).',
      from: { path: '^src/modules/([^/]+)/.+' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/public\\.ts$',
          '^src/modules/[^/]+/schema\\.ts$',
        ],
      },
    },
    {
      name: 'module-tables-owned',
      severity: 'error',
      comment:
        'Таблицы модуля читает и пишет только он сам (правило 4 CLAUDE.md, ADR-0178): другим — его public.ts. Схема модуля может ссылаться на таблицы другого внешним ключом.',
      from: { path: '^src/modules/([^/]+)/', pathNot: '^src/modules/[^/]+/schema\\.ts$' },
      to: { path: '^src/modules/[^/]+/schema\\.ts$', pathNot: '^src/modules/$1/schema\\.ts$' },
    },
    {
      name: 'kernel-tables-via-services',
      severity: 'error',
      comment:
        'Таблицы ядра — через его сервисы (ADR-0178, ADR-0179). Напрямую модуль читает только реестр объектов (соединения списков); людей и оргструктуру — через порт directory() и сервисы kernel/directory. Схема модуля может ссылаться на таблицы ядра внешним ключом.',
      from: {
        path: '^src/modules/',
        pathNot: ['^src/modules/[^/]+/schema\\.ts$', '^src/modules/identity/'],
      },
      to: {
        path: '^src/kernel/[^/]+/schema\\.ts$',
        pathNot: ['^src/kernel/objects/schema\\.ts$'],
      },
    },
    {
      name: 'identity-kernel-tables',
      severity: 'error',
      comment:
        'Модуль входа identity — исключение ровно на справочник (ADR-0179): вход, SSO, синхронизация каталога и импорт сотрудников читают учётную запись и пишут её столбцы входа. Остальные таблицы ядра — через сервисы, как у всех модулей.',
      from: { path: '^src/modules/identity/', pathNot: '^src/modules/identity/schema\\.ts$' },
      to: {
        path: '^src/kernel/[^/]+/schema\\.ts$',
        pathNot: ['^src/kernel/objects/schema\\.ts$', '^src/kernel/directory/schema\\.ts$'],
      },
    },
    {
      name: 'db-schema-for-tooling',
      severity: 'error',
      comment:
        'Сборщик всей схемы (src/db-schema.ts) — только для drizzle-kit, сида, CLI и тестов (ADR-0178): ядро и модули импортируют таблицы у владельца.',
      from: { path: '^src/(kernel|modules|shared)/' },
      to: { path: '^src/db-schema\\.ts$' },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      comment: 'shared/* — низкоуровневый слой без обратных зависимостей.',
      from: { path: '^src/shared' },
      to: { path: '^src/(kernel|modules|cli|seed|db-schema)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклические зависимости запрещены.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    baseDir: __dirname,
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
