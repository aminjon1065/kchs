import type { QueryExportFormat } from '@kchs/contracts'
import { downloadFile } from '~/shared/api/download.js'
import type { ApiBody } from '~/shared/api/route-types.js'

/** Выгрузка данных: маршрут и тело без формата (формат добавляет меню). */
export type ResultData =
  | { path: '/queries/export'; body: Omit<ApiBody<'POST /queries/export'>, 'format'> }
  | {
      path: '/dashboards/:id/export'
      id: string
      body: Omit<ApiBody<'POST /dashboards/:id/export'>, 'format'>
    }

/** Выгрузка результата файлом выбранного формата (ADR-0159). */
export const downloadResult = (data: ResultData, format: QueryExportFormat) =>
  data.path === '/queries/export'
    ? downloadFile('/queries/export', { body: { ...data.body, format } })
    : downloadFile('/dashboards/:id/export', {
        params: { id: data.id },
        body: { ...data.body, format },
      })
