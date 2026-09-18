import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { BigIntString, LangText, Timestamp, Uuid } from '../common/primitives.js'
import { FieldDef, type FieldType } from '../fields/field-def.js'

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
export type StoredFieldType = (typeof STORED_FIELD_TYPES)[number]

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

/** Правка описания поля: подпись, семантика, формат — без изменения хранения. */
export const DatasetFieldPatch = z.object({
  label: LangText.optional(),
  semantic: FieldDef.shape.semantic.optional(),
  format: FieldDef.shape.format.optional(),
  description: z.string().max(1000).nullable().optional(),
  indexed: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  order: z.number().int().optional(),
})
export type DatasetFieldPatch = z.infer<typeof DatasetFieldPatch>

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

/** Правка строки: изменённые значения и версия, которую видел пользователь. */
export const DatasetRowPatch = z.object({
  values: z.record(z.string(), z.unknown()),
  ver: z.number().int().positive(),
})
export type DatasetRowPatch = z.infer<typeof DatasetRowPatch>

/** 409 при правке строки: текущее состояние и поля, изменённые с тех пор другим. */
export const DatasetRowConflict = z.object({
  current: DatasetRow,
  changedFields: z.array(z.string()),
})
export type DatasetRowConflict = z.infer<typeof DatasetRowConflict>

// ─── Версии ──────────────────────────────────────────────────────────────────

export const DATASET_VERSION_ORIGINS = ['create', 'import', 'edit', 'rollback', 'schema'] as const
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
