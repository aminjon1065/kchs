import {
  CorrespondentInput,
  type CorrespondentKind,
  type CorrespondentList,
  type CorrespondentListQuery,
  type CorrespondentRecord,
  type CorrespondentUpdateInput,
} from '@kchs/contracts'
import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { correspondents, documents, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { decodeCursor, encodeCursor } from '~/shared/http/pagination.js'
import { documentsSpaceId } from './space.js'

const COLUMNS = {
  id: correspondents.id,
  kind: correspondents.kind,
  name: correspondents.name,
  details: correspondents.details,
  contacts: correspondents.contacts,
  externalId: correspondents.externalId,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Корреспонденты (04-domain-model.md, 08-documents.md §5): организации и лица
 * с реквизитами и контактами — справочник, открытый сотрудникам (`everyone:
 * view`). Заводят и правят делопроизводители (способность `documents.register`)
 * и ведущие журналы — производный `edit` политики типа.
 */
export const CorrespondentService = {
  async list(ctx: UserCtx, query: CorrespondentListQuery): Promise<CorrespondentList> {
    const conditions = [visibleObjectsSql(ctx, 'correspondent'), sql`${objects.deletedAt} IS NULL`]
    if (query.q?.trim()) {
      const pattern = `%${escapeLike(query.q.trim())}%`
      conditions.push(
        or(
          ilike(correspondents.name, pattern),
          sql`${correspondents.details}->>'shortName' ILIKE ${pattern}`,
          sql`${correspondents.details}->>'taxId' ILIKE ${pattern}`,
        )!,
      )
    }
    if (query.kind) conditions.push(eq(correspondents.kind, query.kind))
    const cursor = decodeCursor<{ name: string; id: string }>(query.cursor)
    if (cursor) {
      conditions.push(
        sql`(${correspondents.name}, ${correspondents.id}) > (${cursor.name}, ${cursor.id})`,
      )
    }
    const rows = await db()
      .select(COLUMNS)
      .from(correspondents)
      .innerJoin(objects, eq(objects.id, correspondents.id))
      .where(and(...conditions))
      .orderBy(asc(correspondents.name), asc(correspondents.id))
      .limit(query.limit + 1)
    const page = rows.slice(0, query.limit)
    return {
      items: await CorrespondentService.records(ctx, page),
      nextCursor:
        rows.length > query.limit && page.length > 0
          ? encodeCursor({ name: page[page.length - 1]?.name, id: page[page.length - 1]?.id })
          : null,
    }
  },

  async get(ctx: UserCtx, id: string): Promise<CorrespondentRecord> {
    await authorize(ctx, 'view', id)
    const [row] = await db()
      .select(COLUMNS)
      .from(correspondents)
      .innerJoin(objects, eq(objects.id, correspondents.id))
      .where(eq(correspondents.id, id))
      .limit(1)
    if (!row) throw errors.notFound('Корреспондент')
    const [record] = await CorrespondentService.records(ctx, [row])
    if (!record) throw errors.notFound('Корреспондент')
    return record
  },

  async records(
    ctx: UserCtx,
    rows: Array<{
      id: string
      kind: string
      name: string
      details: Record<string, string>
      contacts: Record<string, string>
      externalId: string | null
      createdAt: string
      updatedAt: string
    }>,
  ): Promise<CorrespondentRecord[]> {
    if (rows.length === 0) return []
    // Число документов — только видимых смотрящему: гриф и права скрытых не выдают
    const counts = await db()
      .select({ correspondentId: documents.correspondentId, total: count() })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(
        and(
          inArray(
            documents.correspondentId,
            rows.map((row) => row.id),
          ),
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'document'),
        ),
      )
      .groupBy(documents.correspondentId)
    const result: CorrespondentRecord[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'edit', row.id, { soft: true })
      result.push({
        id: row.id,
        kind: row.kind as CorrespondentKind,
        name: row.name,
        details: row.details,
        contacts: row.contacts,
        externalId: row.externalId,
        documentCount: counts.find((item) => item.correspondentId === row.id)?.total ?? 0,
        canEdit: decision.allowed,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    }
    return result
  },

  async create(tx: Executor, ctx: Ctx, raw: CorrespondentInput): Promise<string> {
    requireCapability(ctx, 'documents.register')
    const input = CorrespondentInput.parse(raw)
    if (input.externalId) {
      const [taken] = await tx
        .select({ id: correspondents.id })
        .from(correspondents)
        .where(eq(correspondents.externalId, input.externalId))
        .limit(1)
      if (taken) throw errors.conflict('Корреспондент с таким внешним кодом уже есть')
    }
    const spaceId = await documentsSpaceId(tx)
    const object = await ObjectService.create(tx, ctx, {
      type: 'correspondent',
      spaceId,
      title: input.name,
      subtitle: input.details.shortName ?? null,
      ownerId: null,
      meta: { kind: input.kind },
    })
    await tx.insert(correspondents).values({
      id: object.id,
      kind: input.kind,
      name: input.name,
      details: stripEmpty(input.details),
      contacts: stripEmpty(input.contacts),
      externalId: input.externalId,
    })
    await grantAccess(
      tx,
      ctx,
      object.id,
      [{ principal: { type: 'everyone', id: '*' }, level: 'view' }],
      { quiet: true },
    )
    await publishEvent(tx, ctx, {
      type: 'correspondent.created',
      object: { id: object.id, type: 'correspondent', spaceId, title: input.name },
      payload: { kind: input.kind, name: input.name },
    })
    return object.id
  },

  async update(tx: Executor, ctx: Ctx, id: string, patch: CorrespondentUpdateInput): Promise<void> {
    await authorize(ctx, 'edit', id)
    const values: Record<string, unknown> = {}
    if (patch.kind !== undefined) values.kind = patch.kind
    if (patch.name !== undefined) values.name = patch.name
    if (patch.details !== undefined) values.details = stripEmpty(patch.details)
    if (patch.contacts !== undefined) values.contacts = stripEmpty(patch.contacts)
    if (patch.externalId !== undefined) values.externalId = patch.externalId
    const changed = Object.keys(values)
    if (changed.length === 0) return
    await tx.update(correspondents).set(values).where(eq(correspondents.id, id))
    const object = await ObjectService.update(
      tx,
      ctx,
      id,
      {
        ...(patch.name ? { title: patch.name } : {}),
        ...(patch.details ? { subtitle: patch.details.shortName ?? null } : {}),
        ...(patch.kind ? { meta: { kind: patch.kind }, mergeMeta: true } : {}),
      },
      { silent: !patch.name },
    )
    await publishEvent(tx, ctx, {
      type: 'correspondent.updated',
      object: { id, type: 'correspondent', spaceId: object.spaceId, title: object.title },
      payload: { changed },
    })
  },

  /** Имена корреспондентов для списков и карточек документов. */
  async names(
    executor: Executor,
    ids: string[],
  ): Promise<Map<string, { id: string; kind: CorrespondentKind; name: string }>> {
    if (ids.length === 0) return new Map()
    const rows = await executor
      .select({ id: correspondents.id, kind: correspondents.kind, name: correspondents.name })
      .from(correspondents)
      .where(inArray(correspondents.id, ids))
    return new Map(rows.map((row) => [row.id, { ...row, kind: row.kind as CorrespondentKind }]))
  },
}

function stripEmpty(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
    ),
  )
}
