import { saveBlob } from '../files.js'
import { type RawOptions, send } from './client.js'
import type { ApiPath, MethodTable } from './route-types.js'

/** Имя файла из `Content-Disposition`: `filename*` (UTF-8) важнее `filename`. */
function dispositionName(header: string | null): string | null {
  if (!header) return null
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  if (encoded) return decodeURIComponent(encoded)
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null
}

/**
 * Выгрузка файлом (POST маршрута таблицы с телом): ответ сохраняется под именем из
 * `Content-Disposition`; ошибка — `ApiError`, как у `http`. Заголовки ответа —
 * вызывающему (счётчики выгрузки). Отдельно от клиента: оболочке выгрузка не нужна.
 */
export async function downloadFile<P extends ApiPath<'POST'>>(
  path: P,
  options: MethodTable<'POST'>[P]['args'][0],
  fallbackName = 'export',
): Promise<Headers> {
  const response = await send('POST', path, options as unknown as RawOptions)
  const name = dispositionName(response.headers.get('content-disposition')) ?? fallbackName
  saveBlob(await response.blob(), name)
  return response.headers
}
