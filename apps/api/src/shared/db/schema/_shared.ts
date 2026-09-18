import { sql } from 'drizzle-orm'
import { customType, jsonb, pgSchema } from 'drizzle-orm/pg-core'

/** Схемы БД (05-data-model.md §Общие правила). */
export const opsSchema = pgSchema('ops')
export const yjsSchema = pgSchema('yjs')
export const dsSchema = pgSchema('ds')

/**
 * timestamptz везде (05-data-model.md). Значение всегда возвращается в ISO 8601 —
 * контракты API (`z.iso.datetime`) принимают только этот формат.
 */
const timestamptz = customType<{ data: string; driverData: string | Date }>({
  dataType: () => 'timestamp with time zone',
  fromDriver: (value) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  toDriver: (value) => value,
})

export const tsCol = (name: string) => timestamptz(name)

export const createdAt = () => tsCol('created_at').notNull().default(sql`now()`)
export const updatedAt = () => tsCol('updated_at').notNull().default(sql`now()`)

export const jsonbObject = <T = Record<string, unknown>>(name: string) =>
  jsonb(name).$type<T>().notNull().default(sql`'{}'::jsonb`)

export const jsonbArray = <T = unknown>(name: string) =>
  jsonb(name).$type<T[]>().notNull().default(sql`'[]'::jsonb`)

/** Многоязычная подпись справочника. */
export type LangTextValue = { ru: string; tg?: string; en?: string }
