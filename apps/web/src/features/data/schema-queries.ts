import { ApiError, http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

/**
 * Обращения вкладки «Схема» к API (ADR-0183): поля датасета — добавить, править, сменить
 * тип, удалить; настройки таблицы.
 */
export const schemaApi = {
  addField: (id: string, body: ApiBody<'POST /datasets/:id/fields'>) =>
    http.post('/datasets/:id/fields', { params: { id }, body }),
  updateField: (id: string, key: string, body: ApiBody<'PATCH /datasets/:id/fields/:key'>) =>
    http.patch('/datasets/:id/fields/:key', { params: { id, key }, body }),
  convertField: (
    id: string,
    key: string,
    body: ApiBody<'POST /datasets/:id/fields/:key/convert'>,
  ) => http.post('/datasets/:id/fields/:key/convert', { params: { id, key }, body }),
  removeField: (id: string, key: string) =>
    http.delete('/datasets/:id/fields/:key', { params: { id, key } }),
  updateDataset: (id: string, body: ApiBody<'PATCH /datasets/:id'>) =>
    http.patch('/datasets/:id', { params: { id }, body }),
}

/** Текст ошибки API для тоста или подсказки. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/** Нет права видеть профиль поля — это не сбой. */
export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403
