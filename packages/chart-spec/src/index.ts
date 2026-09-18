/**
 * @kchs/chart-spec — ChartSpec → опция Apache ECharts (ADR-0009, contracts/chart-spec.md).
 * Чистый TypeScript без React и DOM: компилятор работает и в браузере, и на
 * сервере (снимки PNG дашбордов). Тема — параметр, не импорт из дизайн-системы.
 */
export { chartAltText } from './alt-text.js'
export { compileChart } from './compile.js'
export type {
  BrushSelection,
  ChartFilter,
  ChartIssue,
  ChartMeta,
  ChartPick,
  ChartTableColumn,
  ChartTableModel,
  CompiledChart,
  CompileOptions,
  NumberTileModel,
  PickParams,
} from './model.js'
export { suggestChart } from './suggest.js'
export type { ChartColorToken, ChartTheme } from './theme.js'
export { escapeHtml } from './tooltip.js'
