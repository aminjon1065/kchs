import type {
  DocumentStatus,
  DocumentTerritoryItem,
  DocumentTerritoryList,
  LangText,
} from '@kchs/contracts'
import { and, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { territoryIndex } from '~/modules/gis/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documents, documentTypes, links, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

/** Литерал массива Postgres из идентификаторов (UUID без запятых и кавычек). */
const literal = (ids: readonly string[]) => `{${ids.join(',')}}`

/** Поля-территории карточек типов: тип → ключи полей `cardSchema` типа `territory`. */
async function territoryFields(): Promise<Map<string, string[]>> {
  const rows = await db()
    .select({ id: documentTypes.id, schema: documentTypes.cardSchema })
    .from(documentTypes)
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const keys = ((row.schema?.fields ?? []) as Array<{ key?: unknown; type?: unknown }>)
      .filter((field) => field.type === 'territory' && typeof field.key === 'string')
      .map((field) => field.key as string)
    if (keys.length > 0) out.set(row.id, keys)
  }
  return out
}

/**
 * Документы территории для паспорта (ADR-0158): документ относится к территории или
 * вложенной единице по реквизиту «Территория», по полю-территории карточки своего типа
 * (район донесения о ЧС, территория распоряжения штаба) или по связи «о территории».
 * Видимость — предикат ядра на каждый документ: права, участники карточки и гриф не
 * выше допуска смотрящего.
 */
export async function territoryDocuments(
  ctx: UserCtx,
  territoryId: string,
  limit: number,
): Promise<DocumentTerritoryList> {
  const index = await territoryIndex()
  if (!index.byId.has(territoryId)) throw errors.notFound('Территория')
  const ids = index.descendants(territoryId)
  const inside = new Set(ids)
  const fields = await territoryFields()
  const byField: SQL[] = [...fields].flatMap(([typeId, keys]) =>
    keys.map(
      (key) =>
        sql`(${documents.typeId} = ${typeId} AND ${documents.fields}->>${key} = ANY(${literal(ids)}::text[]))`,
    ),
  )
  const linked = sql<string | null>`(SELECT l.target_id::text FROM ${links} l
     WHERE l.source_id = ${documents.id} AND l.kind = 'about_territory'
       AND l.target_id = ANY(${literal(ids)}::uuid[]) LIMIT 1)`
  const where = and(
    isNull(objects.deletedAt),
    visibleObjectsSql(ctx, 'document'),
    or(
      sql`${documents.territoryId} = ANY(${literal(ids)}::uuid[])`,
      ...byField,
      sql`${linked} IS NOT NULL`,
    ),
  )
  const [rows, counted] = await Promise.all([
    db()
      .select({
        id: documents.id,
        title: objects.title,
        typeId: documents.typeId,
        typeName: documentTypes.name,
        status: documents.status,
        regNumber: documents.regNumber,
        regDate: documents.regDate,
        createdAt: objects.createdAt,
        territoryId: documents.territoryId,
        fields: documents.fields,
        linked,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
      .where(where)
      .orderBy(
        desc(sql`coalesce(${documents.regDate}, ${objects.createdAt}::date)`),
        desc(objects.createdAt),
      )
      .limit(limit),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(where),
  ])
  const items = rows.flatMap((row): DocumentTerritoryItem[] => {
    const card = row.territoryId && inside.has(row.territoryId) ? row.territoryId : null
    const values = (row.fields ?? {}) as Record<string, unknown>
    const field = (fields.get(row.typeId) ?? [])
      .map((key) => values[key])
      .find((value): value is string => typeof value === 'string' && inside.has(value))
    const territory = card ?? field ?? row.linked
    if (!territory) return []
    return [
      {
        id: row.id,
        title: row.title,
        typeName: row.typeName as LangText,
        status: row.status as DocumentStatus,
        regNumber: row.regNumber,
        regDate: row.regDate,
        createdAt: new Date(row.createdAt).toISOString(),
        territoryId: territory,
        via: card ? 'card' : field ? 'field' : 'link',
      },
    ]
  })
  return { items, total: counted[0]?.count ?? 0 }
}
