import type { FieldType, ListField } from '@kchs/contracts'
import { type SQL, sql } from 'drizzle-orm'
import { objects } from '~/shared/db/schema/index.js'
import { objectType } from './registry.js'

/**
 * Поле списка объектов: как его фильтровать и сортировать в SQL
 * (02-platform-kernel.md §13 — «модули описывают схему фильтруемых полей типа»).
 * Выражение строится над строкой `objects`; поля модуля обычно читают `objects.meta`.
 */
export interface ListFieldDef {
  key: string
  labelKey: string
  type: FieldType
  sql: SQL
  sortable?: boolean
  options?: Array<{ value: string; labelKey: string }>
}

/** Поля, которые есть у любого объекта реестра. */
export const COMMON_LIST_FIELDS: ListFieldDef[] = [
  {
    key: 'title',
    labelKey: 'common.labels.name',
    type: 'text',
    sql: sql`${objects.title}`,
    sortable: true,
  },
  { key: 'type', labelKey: 'common.labels.type', type: 'select', sql: sql`${objects.type}` },
  {
    key: 'ownerId',
    labelKey: 'common.labels.owner',
    type: 'user',
    sql: sql`${objects.ownerId}`,
  },
  {
    key: 'createdAt',
    labelKey: 'common.labels.createdAt',
    type: 'datetime',
    sql: sql`${objects.createdAt}`,
    sortable: true,
  },
  {
    key: 'updatedAt',
    labelKey: 'common.labels.updatedAt',
    type: 'datetime',
    sql: sql`${objects.updatedAt}`,
    sortable: true,
  },
]

/**
 * Поля списка для типов: общие плюс поля модулей. Для смешанного списка
 * (папки и файлы) поля объединяются — у папок поле размера просто пустое.
 */
export function listFieldsFor(types: string[] = []): Map<string, ListFieldDef> {
  const fields = new Map(COMMON_LIST_FIELDS.map((field) => [field.key, field]))
  for (const type of types) {
    for (const field of objectType(type)?.listFields ?? []) {
      if (!fields.has(field.key)) fields.set(field.key, field)
    }
  }
  return fields
}

export function describeListFields(fields: Map<string, ListFieldDef>): ListField[] {
  return [...fields.values()].map((field) => ({
    key: field.key,
    labelKey: field.labelKey,
    type: field.type,
    sortable: field.sortable ?? false,
    ...(field.options ? { options: field.options } : {}),
  }))
}
