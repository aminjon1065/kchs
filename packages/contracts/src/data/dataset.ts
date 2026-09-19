import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { FilterNode } from '../common/filter.js'
import { BigIntString, LangText, Timestamp, Uuid } from '../common/primitives.js'
import { FieldDef, type FieldType } from '../fields/field-def.js'
import { Bbox } from '../gis/layer.js'
import { QuerySortItem } from './query.js'

/**
 * Датасет — единица данных с владельцем, схемой, версиями, правами и историей
 * (06-analytics-engine.md §3, 05-data-model.md §Данные). Объект реестра типа
 * `dataset`; строки лежат в физической таблице схемы `ds`.
 */
export const DATASET_KINDS = ['table', 'reference'] as const
export const DatasetKind = z.enum(DATASET_KINDS)
export type DatasetKind = z.infer<typeof DatasetKind>

/**
 * Типы полей, у которых есть физический столбец (05-data-model.md, «Типы полей →
 * столбцы»). Вычисляемые (`formula`, `lookup`, `rollup`) и служебные типы в
 * таблице не хранятся.
 */
export const STORED_FIELD_TYPES = [
  'text',
  'long_text',
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'boolean',
  'date',
  'datetime',
  'time',
  'duration',
  'select',
  'multi_select',
  'user',
  'unit',
  'territory',
  'object_ref',
  'file',
  'url',
  'email',
  'phone',
  'geometry',
  'json',
  'identifier',
] as const satisfies readonly FieldType[]
export const StoredFieldType = z.enum(STORED_FIELD_TYPES)
export type StoredFieldType = z.infer<typeof StoredFieldType>

/** Поле датасета: определение поля и его идентификатор. Физическое имя столбца наружу не отдаётся. */
export const DatasetField = FieldDef.extend({ id: Uuid })
export type DatasetField = z.infer<typeof DatasetField>

export const DatasetSettings = z.object({
  /** Строки правятся в таблице (для импортируемых снимков можно выключить). */
  editable: z.boolean().default(true),
  /** Каждая правка строки пишется в историю `ds.h_*`. */
  trackHistory: z.boolean().default(true),
})
export type DatasetSettings = z.infer<typeof DatasetSettings>

export const DatasetRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  kind: DatasetKind,
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  fields: z.array(DatasetField),
  primaryKey: z.array(z.string()),
  timeField: z.string().nullable(),
  territoryField: z.string().nullable(),
  /** Оценка числа строк (обновляется импортом и правками). */
  rowCount: z.number().int().nonnegative(),
  currentVersion: z.number().int().nonnegative(),
  schemaVersion: z.number().int().nonnegative(),
  lastImportAt: Timestamp.nullable(),
  settings: DatasetSettings,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type DatasetRecord = z.infer<typeof DatasetRecord>

/** Поле при создании датасета: определение без идентификатора. */
export const DatasetFieldInput = FieldDef.refine(
  (field) => (STORED_FIELD_TYPES as readonly string[]).includes(field.type),
  { message: 'Тип поля не хранится в таблице датасета', path: ['type'] },
)
export type DatasetFieldInput = z.infer<typeof DatasetFieldInput>

export const DatasetCreateInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    spaceId: Uuid,
    parentId: Uuid.nullable().optional(),
    kind: DatasetKind.default('table'),
    fields: z.array(DatasetFieldInput).min(1).max(500),
    primaryKey: z.array(z.string()).max(8).default([]),
    timeField: z.string().nullable().optional(),
    territoryField: z.string().nullable().optional(),
    settings: DatasetSettings.partial().optional(),
  })
  .superRefine((input, ctx) => {
    const keys = new Set<string>()
    for (const [index, field] of input.fields.entries()) {
      if (keys.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Поле «${field.key}» повторяется`,
          path: ['fields', index, 'key'],
        })
      }
      keys.add(field.key)
    }
    for (const key of [
      ...input.primaryKey,
      ...(input.timeField ? [input.timeField] : []),
      ...(input.territoryField ? [input.territoryField] : []),
    ]) {
      if (!keys.has(key)) {
        ctx.addIssue({ code: 'custom', message: `Нет поля «${key}»`, path: ['fields'] })
      }
    }
  })
export type DatasetCreateInput = z.infer<typeof DatasetCreateInput>

/**
 * Правка описания поля без изменения хранения (ADR-0047): подпись, семантика,
 * формат, справочник. Ключ поля неизменен — на него ссылаются запросы и графики.
 */
export const DatasetFieldPatch = z.object({
  label: LangText.optional(),
  semantic: FieldDef.shape.semantic.optional(),
  format: FieldDef.shape.format.optional(),
  description: z.string().max(1000).nullable().optional(),
  unit: z.string().max(32).nullable().optional(),
  required: z.boolean().optional(),
  indexed: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  order: z.number().int().optional(),
  /** Варианты поля выбора. */
  options: FieldDef.shape.options,
  /** Справочник: значение поля — ключ строки другого датасета, в гриде видна подпись. */
  lookup: FieldDef.shape.lookup.unwrap().nullable().optional(),
})
export type DatasetFieldPatch = z.infer<typeof DatasetFieldPatch>

/** Смена типа поля: пробный прогон с отчётом, затем применение (ADR-0047). */
export const DatasetFieldConvertInput = z.object({
  type: StoredFieldType,
  format: FieldDef.shape.format.optional(),
  /** Только отчёт — таблица не меняется. */
  dryRun: z.boolean().default(true),
  /** Применить, даже если часть значений не приводится: они станут пустыми. */
  allowLoss: z.boolean().default(false),
})
export type DatasetFieldConvertInput = z.infer<typeof DatasetFieldConvertInput>

export const DatasetFieldConvertReport = z.object({
  /** Непустых значений в живых строках. */
  total: z.number().int().nonnegative(),
  /** Из них не приводятся к новому типу. */
  failed: z.number().int().nonnegative(),
  sample: z.array(z.object({ rowId: BigIntString, value: z.string() })).max(20),
  applied: z.boolean(),
})
export type DatasetFieldConvertReport = z.infer<typeof DatasetFieldConvertReport>

/** Настройки датасета: описание, ключ строки, поля времени и территории, правка. */
export const DatasetUpdateInput = z.object({
  description: z.string().max(2000).nullable().optional(),
  primaryKey: z.array(z.string()).max(8).optional(),
  timeField: z.string().nullable().optional(),
  territoryField: z.string().nullable().optional(),
  settings: z
    .object({ editable: z.boolean().optional(), trackHistory: z.boolean().optional() })
    .optional(),
})
export type DatasetUpdateInput = z.infer<typeof DatasetUpdateInput>

/**
 * Профиль столбца (P1-E03 S02): пустые, различные, диапазон, распределение и
 * частые значения — по выборке для крупных таблиц. Для маскируемого поля — только
 * счётчики, без значений.
 */
export const FieldProfile = z.object({
  field: z.string(),
  type: StoredFieldType,
  /** Версия датасета, по которой посчитан профиль. */
  version: z.number().int().nonnegative(),
  /** Строк в профиле: все живые строки или выборка. */
  rows: z.number().int().nonnegative(),
  sampled: z.boolean(),
  empty: z.number().int().nonnegative(),
  distinct: z.number().int().nonnegative(),
  masked: z.boolean(),
  /** Минимум и максимум текстом (числа, даты, время). */
  min: z.string().nullable(),
  max: z.string().nullable(),
  mean: z.number().nullable(),
  /** Числа, даты и время: равные интервалы значений. */
  histogram: z.array(z.object({ from: z.string(), to: z.string(), count: z.number().int() })),
  /** Самые частые значения (для геометрии — типы геометрий). */
  top: z.array(z.object({ value: z.string(), count: z.number().int() })),
  computedAt: Timestamp,
})
export type FieldProfile = z.infer<typeof FieldProfile>

// ─── Строки ──────────────────────────────────────────────────────────────────

/**
 * Строка датасета: системные `_id` (bigint строкой) и `_ver` (оптимистичная
 * блокировка) и значения полей по ключам.
 */
export const DatasetRow = z.object({
  _id: BigIntString,
  _ver: z.number().int().positive(),
  values: z.record(z.string(), z.unknown()),
})
export type DatasetRow = z.infer<typeof DatasetRow>

export const DatasetRowInput = z.object({
  values: z.record(z.string(), z.unknown()),
})
export type DatasetRowInput = z.infer<typeof DatasetRowInput>

/** Правка строки: изменённые значения и версия, которую видел пользователь. */
export const DatasetRowPatch = z.object({
  values: z.record(z.string(), z.unknown()),
  ver: z.number().int().positive(),
})
export type DatasetRowPatch = z.infer<typeof DatasetRowPatch>

/**
 * Страница строк для таблицы датасета (ADR-0051): фильтр, сортировка, быстрый
 * поиск по текстовым полям и смещение; строки — с `_id` и `_ver`, через
 * компилятор запросов с политиками пользователя.
 */
export const DatasetRowsQuery = z.object({
  where: FilterNode.optional(),
  /**
   * Охват карты (атрибутивная таблица слоя, связанные представления, ADR-0073):
   * строки, рамка геометрии которых пересекает охват, — пространственное окно
   * компилятора рядом с политикой строк, по индексу GIST (ADR-0064).
   */
  bbox: z
    .object({
      field: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z_][a-z0-9_]*$/),
      bbox: Bbox,
    })
    .optional(),
  sort: z.array(QuerySortItem).max(8).default([]),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  offset: z.number().int().min(0).default(0),
  /** Посчитать все строки под фильтром — для «1 245 из 2,3 млн». */
  count: z.boolean().default(true),
})
export type DatasetRowsQuery = z.infer<typeof DatasetRowsQuery>

export const DatasetRowsInsert = z.object({ rows: z.array(DatasetRowInput).min(1).max(1000) })
export type DatasetRowsInsert = z.infer<typeof DatasetRowsInsert>

export const DatasetRowsDelete = z.object({ ids: z.array(BigIntString).min(1).max(1000) })
export type DatasetRowsDelete = z.infer<typeof DatasetRowsDelete>

/** Запись истории строки (`ds.h_*`): что стало и что было. */
export const DatasetRowHistoryEntry = z.object({
  id: BigIntString,
  op: z.enum(['insert', 'update', 'delete']),
  ver: z.number().int().positive(),
  values: z.record(z.string(), z.unknown()),
  previous: z.record(z.string(), z.unknown()).nullable(),
  changedBy: UserRef.nullable(),
  changedAt: Timestamp,
})
export type DatasetRowHistoryEntry = z.infer<typeof DatasetRowHistoryEntry>

/** 409 при правке строки: текущее состояние и поля, изменённые с тех пор другим. */
export const DatasetRowConflict = z.object({
  current: DatasetRow,
  changedFields: z.array(z.string()),
})
export type DatasetRowConflict = z.infer<typeof DatasetRowConflict>

// ─── Версии ──────────────────────────────────────────────────────────────────

/** `analysis` — строки заменены результатом пространственного анализа (ADR-0069). */
export const DATASET_VERSION_ORIGINS = [
  'create',
  'import',
  'edit',
  'rollback',
  'schema',
  'analysis',
] as const
export const DatasetVersionOrigin = z.enum(DATASET_VERSION_ORIGINS)

export const DatasetVersion = z.object({
  number: z.number().int().nonnegative(),
  origin: DatasetVersionOrigin,
  createdAt: Timestamp,
  createdBy: UserRef.nullable(),
  rowCount: z.number().int().nonnegative(),
  diff: z.object({
    added: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
  importId: Uuid.nullable(),
})
export type DatasetVersion = z.infer<typeof DatasetVersion>
