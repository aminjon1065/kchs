/**
 * Маршруты страницы печати отчёта вне оболочки (03-screens.md §21, ADR-0078):
 * `/print/report/<запуск>` — движок и получатель своего запуска,
 * `/print/report-preview/<отчёт>` — предпросмотр текущего шаблона.
 * Отдельный лёгкий модуль: оболочка не тянет страницу печати в свой бандл.
 */
export type PrintTarget = { kind: 'run'; runId: string } | { kind: 'preview'; reportId: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function printTargetFromPath(pathname: string): PrintTarget | null {
  const run = new RegExp(`^/print/report/(${UUID})/?$`, 'i').exec(pathname)
  if (run?.[1]) return { kind: 'run', runId: run[1] }
  const preview = new RegExp(`^/print/report-preview/(${UUID})/?$`, 'i').exec(pathname)
  if (preview?.[1]) return { kind: 'preview', reportId: preview[1] }
  return null
}

/** Адрес предпросмотра печати отчёта — открывается в новой вкладке браузера. */
export const reportPreviewPath = (reportId: string) => `/print/report-preview/${reportId}`
