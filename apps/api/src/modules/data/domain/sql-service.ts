import type { FieldType, LangText, SqlSchema, SqlSchemaTable } from '@kchs/contracts'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { datasetColumnPolicies, datasetFields, objects } from '~/shared/db/schema/index.js'

/** Датасетов в подсказках редактора — самые свежие из доступных. */
const MAX_TABLES = 200

const spaceObject = alias(objects, 'space_object')

/**
 * Схема для автодополнения SQL-лаборатории: датасеты, видимые пользователю, и
 * их поля по порядку. Скрытые политикой столбцов поля в подсказки не попадают
 * ни для кого — даже управляющий, который их видит, просто наберёт имя сам:
 * подсказки не должны раскрывать больше, чем покажет запрос.
 */
export const SqlService = {
  async schema(ctx: Ctx): Promise<SqlSchema> {
    requireCapability(ctx, 'data.sql')
    const found = await db()
      .select({ id: objects.id, name: objects.title, space: spaceObject.title })
      .from(objects)
      .leftJoin(spaceObject, eq(spaceObject.id, objects.spaceId))
      .where(
        and(
          eq(objects.type, 'dataset'),
          isNull(objects.deletedAt),
          visibleObjectsSql(ctx, 'dataset'),
        ),
      )
      .orderBy(desc(objects.updatedAt))
      .limit(MAX_TABLES + 1)
    const tables = found.slice(0, MAX_TABLES)
    if (tables.length === 0) return { tables: [], truncated: false }
    const ids = tables.map((table) => table.id)

    const [fields, hidePolicies] = await Promise.all([
      db()
        .select({
          datasetId: datasetFields.datasetId,
          key: datasetFields.key,
          label: datasetFields.label,
          type: datasetFields.type,
        })
        .from(datasetFields)
        .where(inArray(datasetFields.datasetId, ids))
        .orderBy(asc(datasetFields.order)),
      db()
        .select({
          datasetId: datasetColumnPolicies.datasetId,
          principalType: datasetColumnPolicies.principalType,
          principalId: datasetColumnPolicies.principalId,
          fields: datasetColumnPolicies.fields,
        })
        .from(datasetColumnPolicies)
        .where(
          and(
            inArray(datasetColumnPolicies.datasetId, ids),
            eq(datasetColumnPolicies.mode, 'hide'),
          ),
        ),
    ])

    const keys = new Set(ctx.kind === 'user' ? ctx.principals.keys : [])
    const hidden = new Map<string, Set<string>>()
    for (const policy of hidePolicies) {
      if (!keys.has(`${policy.principalType}:${policy.principalId}`)) continue
      const set = hidden.get(policy.datasetId) ?? new Set<string>()
      for (const field of policy.fields) set.add(field)
      hidden.set(policy.datasetId, set)
    }
    const columns = new Map<string, SqlSchemaTable['columns']>()
    for (const field of fields) {
      if (hidden.get(field.datasetId)?.has(field.key)) continue
      const list = columns.get(field.datasetId) ?? []
      list.push({ key: field.key, label: field.label as LangText, type: field.type as FieldType })
      columns.set(field.datasetId, list)
    }
    return {
      tables: tables.map((table) => ({
        id: table.id,
        name: table.name,
        space: table.space ?? null,
        columns: columns.get(table.id) ?? [],
      })),
      truncated: found.length > MAX_TABLES,
    }
  },
}
