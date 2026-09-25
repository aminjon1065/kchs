/**
 * Маршруты страницы печати вне оболочки (03-screens.md §21, ADR-0078, ADR-0159):
 * `/print/report/<запуск>` — движок и получатель своего запуска,
 * `/print/report-preview/<отчёт>` — предпросмотр текущего шаблона,
 * `/print/dashboard/<дашборд>?filters=…` — лист дашборда с фильтрами экрана.
 * Отдельный лёгкий модуль: оболочка не тянет страницу печати в свой бандл.
 */
export type PrintTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'preview'; reportId: string }
  | { kind: 'dashboard'; dashboardId: string; filters: Record<string, unknown> }

/** Значения фильтров дашборда из адреса; испорченный параметр — без фильтров. */
function dashboardFilters(search: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new URLSearchParams(search).get('filters') ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function printTargetFromPath(pathname: string, search = ''): PrintTarget | null {
  const run = new RegExp(`^/print/report/(${UUID})/?$`, 'i').exec(pathname)
  if (run?.[1]) return { kind: 'run', runId: run[1] }
  const preview = new RegExp(`^/print/report-preview/(${UUID})/?$`, 'i').exec(pathname)
  if (preview?.[1]) return { kind: 'preview', reportId: preview[1] }
  const dashboard = new RegExp(`^/print/dashboard/(${UUID})/?$`, 'i').exec(pathname)
  if (dashboard?.[1]) {
    return { kind: 'dashboard', dashboardId: dashboard[1], filters: dashboardFilters(search) }
  }
  return null
}

/** Адрес предпросмотра печати отчёта — открывается в новой вкладке браузера. */
export const reportPreviewPath = (reportId: string) => `/print/report-preview/${reportId}`

/** Лист печати дашборда с фильтрами экрана — открывается в новой вкладке браузера. */
export function dashboardPrintPath(dashboardId: string, filters: Record<string, unknown>): string {
  const query =
    Object.keys(filters).length > 0 ? `?filters=${encodeURIComponent(JSON.stringify(filters))}` : ''
  return `/print/dashboard/${dashboardId}${query}`
}
