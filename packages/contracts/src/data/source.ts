import { z } from 'zod'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'
import { StoredFieldType } from './dataset.js'

/**
 * Источник датасета — объект реестра типа `source` (05-data-model.md §Данные,
 * 14-automation-integrations.md §5, ADR-0107): подключение к внешней СУБД
 * (интеграция вида `postgres`/`mysql`) плюс запрос или таблица, из которой
 * заданием наполняется датасет. Учётные данные живут в интеграции и наружу не
 * отдаются; здесь — только что и как читать.
 */
export const SOURCE_KINDS = ['database'] as const
export const SourceKind = z.enum(SOURCE_KINDS)
export type SourceKind = z.infer<typeof SourceKind>

/** Снимок — полная перезагрузка версии; инкремент — добор по полю-курсору. */
export const SOURCE_MODES = ['snapshot', 'incremental'] as const
export const SourceMode = z.enum(SOURCE_MODES)
export type SourceMode = z.infer<typeof SourceMode>

export const SOURCE_STATUSES = ['draft', 'queued', 'running', 'ok', 'error'] as const
export const SourceStatus = z.enum(SOURCE_STATUSES)
export type SourceStatus = z.infer<typeof SourceStatus>

/** Что читаем у внешней базы: таблицу целиком или заданный запрос. */
export const SourceQuery = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('table'),
    schema: z.string().trim().min(1).max(120),
    table: z.string().trim().min(1).max(200),
  }),
  z.object({ kind: z.literal('sql'), sql: z.string().trim().min(1).max(20_000) }),
])
export type SourceQuery = z.infer<typeof SourceQuery>

/** Столбец внешней выборки и поле датасета, в которое он ложится. */
export const SourceColumn = z.object({
  /** Имя столбца во внешней базе. */
  name: z.string().min(1).max(200),
  /** Тип, как его назвала внешняя база (для показа человеку). */
  nativeType: z.string().max(120),
  type: StoredFieldType,
  label: LangText.optional(),
  /** Ключ поля датасета; пусто — столбец не загружается. */
  key: z
    .string()
    .max(60)
    .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: латиница, цифры и подчёркивание')
    .optional(),
})
export type SourceColumn = z.infer<typeof SourceColumn>

/** Больше строк один прогон не переносит: защита от случайной выгрузки склада. */
export const SOURCE_MAX_ROWS = 5_000_000
/** Столько строк показывает предпросмотр внешней выборки. */
export const SOURCE_PREVIEW_ROWS = 50
/** Сколько ждём внешнюю базу при проверке связи и предпросмотре, мс. */
export const SOURCE_PROBE_TIMEOUT_MS = 10_000

export const SourceRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  kind: SourceKind,
  /** Интеграция с подключением (`postgres`/`mysql`). */
  integrationId: Uuid,
  integrationName: z.string().nullable(),
  integrationKind: z.string().nullable(),
  query: SourceQuery,
  mode: SourceMode,
  /** Поле-курсор инкремента во внешней выборке. */
  cursorField: z.string().nullable(),
  /** Последнее перенесённое значение курсора (текстом). */
  cursorValue: z.string().nullable(),
  /** Ключ датасета для инкремента: по нему строки обновляются. */
  keyFields: z.array(z.string()),
  columns: z.array(SourceColumn),
  datasetId: Uuid.nullable(),
  schedule: z.string().nullable(),
  enabled: z.boolean(),
  status: SourceStatus,
  statusMessage: z.string().nullable(),
  lastCheckAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  jobId: Uuid.nullable(),
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type SourceRecord = z.infer<typeof SourceRecord>

export const SourceListItem = SourceRecord.pick({
  id: true,
  name: true,
  spaceId: true,
  kind: true,
  mode: true,
  status: true,
  schedule: true,
  enabled: true,
  datasetId: true,
  rowCount: true,
  lastRunAt: true,
})
export type SourceListItem = z.infer<typeof SourceListItem>

export const SourceList = z.object({ items: z.array(SourceListItem) })
export type SourceList = z.infer<typeof SourceList>

const sourceShape = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  integrationId: Uuid,
  query: SourceQuery,
  mode: SourceMode.default('snapshot'),
  cursorField: z.string().trim().max(200).nullable().optional(),
  keyFields: z.array(z.string().min(1).max(60)).max(10).default([]),
  columns: z.array(SourceColumn).min(1).max(300),
  schedule: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().default(true),
}

export const SourceCreateInput = z.object({
  ...sourceShape,
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  /** Название датасета-результата; по умолчанию — название источника. */
  datasetName: z.string().trim().min(1).max(200).optional(),
})
export type SourceCreateInput = z.infer<typeof SourceCreateInput>

export const SourceUpdateInput = z.object({
  name: sourceShape.name.optional(),
  description: sourceShape.description,
  query: SourceQuery.optional(),
  mode: SourceMode.optional(),
  cursorField: sourceShape.cursorField,
  keyFields: z.array(z.string().min(1).max(60)).max(10).optional(),
  columns: z.array(SourceColumn).min(1).max(300).optional(),
  schedule: sourceShape.schedule,
  enabled: z.boolean().optional(),
})
export type SourceUpdateInput = z.infer<typeof SourceUpdateInput>

/** Предпросмотр внешней выборки: столбцы с типами и несколько строк. */
export const SourcePreviewInput = z.object({
  integrationId: Uuid,
  query: SourceQuery,
  limit: z.number().int().min(1).max(SOURCE_PREVIEW_ROWS).default(20),
})
export type SourcePreviewInput = z.infer<typeof SourcePreviewInput>

export const SourcePreview = z.object({
  columns: z.array(SourceColumn),
  rows: z.array(z.array(z.unknown())),
})
export type SourcePreview = z.infer<typeof SourcePreview>

/** Список таблиц внешней базы для выбора без ручного ввода. */
export const SourceTable = z.object({
  schema: z.string(),
  table: z.string(),
  rows: z.number().int().nonnegative().nullable(),
})
export type SourceTable = z.infer<typeof SourceTable>

export const SourceTableList = z.object({ items: z.array(SourceTable) })
export type SourceTableList = z.infer<typeof SourceTableList>

export const SourceRunRecord = z.object({
  id: Uuid,
  sourceId: Uuid,
  jobId: Uuid.nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  mode: SourceMode,
  stats: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type SourceRunRecord = z.infer<typeof SourceRunRecord>

export const SourceRunList = z.object({ items: z.array(SourceRunRecord) })
export type SourceRunList = z.infer<typeof SourceRunList>

export const SourceRunStarted = z.object({ jobId: Uuid, runId: Uuid })
export type SourceRunStarted = z.infer<typeof SourceRunStarted>

/** Результат задания синхронизации (`JobRecord.result`). */
export const SourceRunResult = z.object({
  datasetId: Uuid,
  rows: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
})
export type SourceRunResult = z.infer<typeof SourceRunResult>
