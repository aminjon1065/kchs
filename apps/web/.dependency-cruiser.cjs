/**
 * Границы клиента kchs (01-project-structure.md §apps/web, ADR-0183). Слои снизу вверх:
 *  - shared/   — клиент API, i18n, оформление, realtime, утилиты; не знает ничего выше
 *  - entities/ — сквозные компоненты сущностей (доступ, выбор людей и объектов, загрузка);
 *                знают только shared
 *  - features/ — экраны и компоненты модулей; чужая feature — только через её index.ts
 *  - app/      — оболочка; фичи знает только точка сборки модулей
 * Нарушения, которые были до правил, лежат в базе известных
 * (`.dependency-cruiser-known-violations.json`); CI падает на новых.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклические зависимости запрещены.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'features-only-via-index',
      severity: 'error',
      comment: 'Чужая feature — только через её публичный вход features/<m>/index.ts.',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/',
        pathNot: ['^src/features/$1/', '^src/features/[^/]+/index\\.tsx?$'],
      },
    },
    {
      name: 'no-upward-to-app',
      severity: 'error',
      comment: 'Оболочка app/ — верхний слой: фичи, entities и shared её не импортируют.',
      from: { path: '^src/(features|entities|shared)/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'app-knows-features-only-in-composition-root',
      severity: 'error',
      comment: 'Оболочка знает фичи только в точке сборки модулей (app/modules.tsx).',
      from: { path: '^src/app/', pathNot: '^src/app/modules\\.tsx$' },
      to: { path: '^src/features/' },
    },
    {
      name: 'entities-below-features',
      severity: 'error',
      comment: 'entities/ — ниже фич: сквозные компоненты не знают модулей.',
      from: { path: '^src/entities/' },
      to: { path: '^src/(features|app)/' },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      comment: 'shared/ — нижний слой без обратных зависимостей.',
      from: { path: '^src/shared/' },
      to: { path: '^src/(app|features|entities)/' },
    },
    {
      name: 'api-client-in-api-layer',
      severity: 'error',
      comment:
        'Обращения к API — в слое запросов фичи (api/, queries), в entities и shared, а не в компонентах.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/features/[^/]+/(api/|queries\\.tsx?$|[^/]+-queries\\.tsx?$|.*/queries\\.tsx?$)',
          '^src/entities/',
          '^src/shared/',
          '\\.test\\.tsx?$',
        ],
      },
      // Клиент и выгрузка файлом — вызовы API; типы маршрутов (route-types) и адреса ссылок (link) — нет
      to: { path: '^src/shared/api/(client|download)\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.tsx?$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts', '.tsx', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
