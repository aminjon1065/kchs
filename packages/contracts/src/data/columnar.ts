import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Колоночный tier (06-analytics-engine.md §19, ADR-0109): копия версии датасета
 * в Parquet, тяжёлые агрегаты по ней считает DuckDB в движке.
 */

/** Где выполнился запрос — это видит пользователь рядом с результатом. */
export const QUERY_EXECUTORS = ['postgres', 'columnar'] as const
export const QueryExecutor = z.enum(QUERY_EXECUTORS)
export type QueryExecutor = z.infer<typeof QueryExecutor>

/** Выбор исполнителя в спецификации: авто по размеру датасета или явный. */
export const QUERY_EXECUTOR_CHOICES = ['auto', 'postgres', 'columnar'] as const
export const QueryExecutorChoice = z.enum(QUERY_EXECUTOR_CHOICES)
export type QueryExecutorChoice = z.infer<typeof QueryExecutorChoice>

/**
 * Состояние копии: `none` — не собиралась, `building` — собирается,
 * `ready` — готова, `stale` — данные ушли вперёд, `failed` — сборка не удалась.
 */
export const COLUMNAR_STATUSES = ['none', 'building', 'ready', 'stale', 'failed'] as const
export const ColumnarStatus = z.enum(COLUMNAR_STATUSES)
export type ColumnarStatus = z.infer<typeof ColumnarStatus>

export const ColumnarCopy = z.object({
  datasetId: Uuid,
  status: ColumnarStatus,
  /** Версия данных, с которой снята копия; null — копии ещё нет. */
  version: z.number().int().nonnegative().nullable(),
  /** Текущая версия данных датасета: расходится с `version` — копия устарела. */
  datasetVersion: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** Сколько заняла сборка, мс. */
  buildMs: z.number().int().nonnegative().nullable(),
  builtAt: Timestamp.nullable(),
  requestedAt: Timestamp.nullable(),
  error: z.string().nullable(),
  /** Копия годится для запросов прямо сейчас (готова и той же версии). */
  fresh: z.boolean(),
  /** Датасет достаточно велик, чтобы запросы уходили в копию сами. */
  eligible: z.boolean(),
})
export type ColumnarCopy = z.infer<typeof ColumnarCopy>

/** Настройки колоночного tier (администрирование). */
export const ColumnarSettings = z.object({
  /** Выключено — все запросы считает Postgres, копии не собираются. */
  enabled: z.boolean().default(true),
  /** От скольких строк датасет получает копию и агрегаты уходят в неё. */
  minRows: z.number().int().min(1000).max(1_000_000_000).default(1_000_000),
})
export type ColumnarSettings = z.infer<typeof ColumnarSettings>

export const ColumnarSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  minRows: z.number().int().min(1000).max(1_000_000_000).optional(),
})
export type ColumnarSettingsPatch = z.infer<typeof ColumnarSettingsPatch>

/** Строка списка копий в администрировании. */
export const ColumnarAdminEntry = ColumnarCopy.extend({
  name: z.string(),
  spaceId: Uuid,
})
export type ColumnarAdminEntry = z.infer<typeof ColumnarAdminEntry>

export const ColumnarAdmin = z.object({
  settings: ColumnarSettings,
  items: z.array(ColumnarAdminEntry),
})
export type ColumnarAdmin = z.infer<typeof ColumnarAdmin>
