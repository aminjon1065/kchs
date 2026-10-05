import { z } from 'zod'

/** Общие схемы таблиц маршрутов (ADR-0188). */

/** Параметр пути `:id` — идентификатор объекта. */
export const IdParam = z.object({ id: z.uuid() })

/** Параметры пути строки датасета или слоя: `:id/…/:rowId`. */
export const RowParams = z.object({ id: z.uuid(), rowId: z.string().regex(/^\d{1,18}$/) })

/** Ответ «сделано» без данных. */
export const Ok = z.object({ ok: z.boolean() })
