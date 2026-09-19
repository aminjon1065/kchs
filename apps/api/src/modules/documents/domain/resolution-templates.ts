import type {
  ResolutionTemplate,
  ResolutionTemplateInput,
  ResolutionTemplateUpdateInput,
} from '@kchs/contracts'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { hasCapability, requireCapability } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { resolutionTemplates } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'

/** Общие шаблоны ведёт тот, кто ведёт справочники документооборота. */
const SHARED_CAPABILITY = 'documents.journals.manage'

type Row = typeof resolutionTemplates.$inferSelect

function record(ctx: UserCtx, row: Row): ResolutionTemplate {
  const shared = row.ownerId === null
  return {
    id: row.id,
    text: row.text,
    dueWorkingDays: row.dueWorkingDays,
    control: row.control,
    shared,
    canEdit: shared ? hasCapability(ctx, SHARED_CAPABILITY) : row.ownerId === ctx.userId,
  }
}

async function editable(tx: Executor, ctx: UserCtx, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(resolutionTemplates)
    .where(eq(resolutionTemplates.id, id))
    .limit(1)
  if (!row || (row.ownerId !== null && row.ownerId !== ctx.userId)) {
    throw errors.notFound('Шаблон резолюции')
  }
  if (row.ownerId === null) requireCapability(ctx, SHARED_CAPABILITY)
  return row
}

/** Изменение справочника — событие настроек (лента администрирования, кэши). */
async function changed(tx: Executor, ctx: UserCtx, id: string): Promise<void> {
  await publishEvent(tx, ctx, {
    type: 'settings.changed',
    object: null,
    payload: { scope: 'resolution_templates', key: id },
  })
}

/**
 * Шаблоны резолюций (08-documents.md §6, ADR-0084): быстрый ввод — «Прошу
 * рассмотреть и доложить», «К исполнению»… Общие ведёт канцелярия, личные —
 * каждый для себя; стартовый набор общих — миграция.
 */
export const ResolutionTemplates = {
  async list(ctx: UserCtx): Promise<ResolutionTemplate[]> {
    const rows = await db()
      .select()
      .from(resolutionTemplates)
      .where(or(isNull(resolutionTemplates.ownerId), eq(resolutionTemplates.ownerId, ctx.userId)))
      .orderBy(
        sql`${resolutionTemplates.ownerId} IS NULL DESC`,
        asc(resolutionTemplates.sort),
        asc(resolutionTemplates.createdAt),
      )
    return rows.map((row) => record(ctx, row))
  },

  async create(tx: Executor, ctx: UserCtx, input: ResolutionTemplateInput): Promise<string> {
    if (input.shared) requireCapability(ctx, SHARED_CAPABILITY)
    const ownerId = input.shared ? null : ctx.userId
    const [last] = await tx
      .select({ sort: sql<number>`coalesce(max(${resolutionTemplates.sort}), 0)::int` })
      .from(resolutionTemplates)
      .where(
        ownerId ? eq(resolutionTemplates.ownerId, ownerId) : isNull(resolutionTemplates.ownerId),
      )
    const id = newId()
    await tx.insert(resolutionTemplates).values({
      id,
      ownerId,
      text: input.text,
      dueWorkingDays: input.dueWorkingDays,
      control: input.control,
      sort: (last?.sort ?? 0) + 1,
    })
    await changed(tx, ctx, id)
    return id
  },

  async update(
    tx: Executor,
    ctx: UserCtx,
    id: string,
    patch: ResolutionTemplateUpdateInput,
  ): Promise<ResolutionTemplate> {
    await editable(tx, ctx, id)
    const [row] = await tx
      .update(resolutionTemplates)
      .set({
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.dueWorkingDays !== undefined ? { dueWorkingDays: patch.dueWorkingDays } : {}),
        ...(patch.control !== undefined ? { control: patch.control } : {}),
      })
      .where(eq(resolutionTemplates.id, id))
      .returning()
    if (!row) throw errors.notFound('Шаблон резолюции')
    await changed(tx, ctx, id)
    return record(ctx, row)
  },

  async remove(tx: Executor, ctx: UserCtx, id: string): Promise<void> {
    await editable(tx, ctx, id)
    await tx.delete(resolutionTemplates).where(and(eq(resolutionTemplates.id, id)))
    await changed(tx, ctx, id)
  },
}
