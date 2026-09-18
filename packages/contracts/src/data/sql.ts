import { z } from 'zod'
import { LangText, Uuid } from '../common/primitives.js'
import { FieldType } from '../fields/field-def.js'

/**
 * SQL-лаборатория (06-analytics-engine.md §6, ADR-0052): сырой SELECT над
 * датасетами по их названиям и подписям полей; выполняется с политиками
 * пользователя под ролью `kchs_query`. Нужна способность `data.sql`.
 */
export const SQL_MAX_LENGTH = 100_000

export const SqlRunInput = z.object({
  sql: z.string().min(1).max(SQL_MAX_LENGTH),
  /** Значения параметров `{{имя}}`. */
  params: z.record(z.string(), z.unknown()).default({}),
})
export type SqlRunInput = z.infer<typeof SqlRunInput>

/** Таблица для автодополнения: датасет, доступный пользователю, без скрытых полей. */
export const SqlSchemaTable = z.object({
  id: Uuid,
  name: z.string(),
  /** Пространство датасета — для различения одноимённых. */
  space: z.string().nullable(),
  columns: z.array(z.object({ key: z.string(), label: LangText, type: FieldType })),
})
export type SqlSchemaTable = z.infer<typeof SqlSchemaTable>

export const SqlSchema = z.object({
  tables: z.array(SqlSchemaTable),
  /** Датасетов больше, чем помещается в подсказки. */
  truncated: z.boolean(),
})
export type SqlSchema = z.infer<typeof SqlSchema>
