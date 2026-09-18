/**
 * Границы модулей kchs (02-architecture/01-overview.md).
 *  - modules/* → kernel, shared, packages и modules/<other>/public.ts — и ничего больше
 *  - kernel/*  → не знает о modules/*
 *  - shared/*  → низкоуровневый слой без обратных зависимостей
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
      comment: 'Модуль обращается к другому модулю только через его public.ts.',
      from: { path: '^src/modules/([^/]+)/.+' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/public\\.ts$'],
      },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      comment: 'shared/* — низкоуровневый слой без обратных зависимостей.',
      from: { path: '^src/shared' },
      to: { path: '^src/(kernel|modules)' },
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
