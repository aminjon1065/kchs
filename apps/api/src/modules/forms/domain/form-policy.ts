import type { AccessReason, Level } from '@kchs/contracts'
import { arrayContains, arrayOverlaps, eq, type SQL, sql } from 'drizzle-orm'
import type { TypePolicy } from '~/kernel/access/types.js'
import { db } from '~/shared/db/client.js'
import { forms, objects } from '~/shared/db/schema/index.js'

/**
 * Политика типа `form` (03-access-model.md §5, ADR-0103, ADR-0129):
 * - назначенный (сам человек, сотрудник назначенного подразделения или
 *   ответственный за сдачу подразделения) видит форму — иначе он не смог бы
 *   сдать сводку;
 * - ответственный за приёмку правит форму: принимает и возвращает сводки.
 *
 * Множества денормализованы в столбцы-массивы при сохранении формы: один и
 * тот же набор читают `authorize()`, списки и поиск.
 */
const reason = (level: Level, key: 'form_assignee' | 'form_reviewer'): AccessReason => ({
  kind: 'type_policy',
  level,
  messageKey: `access.reason.${key}`,
  params: {},
  sourceObjectId: null,
})

export const formPolicy: TypePolicy = {
  principals: async (object, executor) => {
    const [row] = await executor
      .select({
        units: forms.assignedUnits,
        users: forms.assignedUsers,
        reviewers: forms.reviewers,
        responsible: forms.responsibleUsers,
      })
      .from(forms)
      .where(eq(forms.id, object.id))
      .limit(1)
    if (!row) return []
    return [
      ...row.units.map((id) => `unit:${id}`),
      ...row.users.map((id) => `user:${id}`),
      ...row.reviewers.map((id) => `user:${id}`),
      ...row.responsible.map((id) => `user:${id}`),
    ]
  },

  derive: async (ctx, object) => {
    const [row] = await db()
      .select({
        units: forms.assignedUnits,
        users: forms.assignedUsers,
        reviewers: forms.reviewers,
        responsible: forms.responsibleUsers,
      })
      .from(forms)
      .where(eq(forms.id, object.id))
      .limit(1)
    if (!row) return []
    const result: Array<{ level: Level; reason: AccessReason }> = []
    if (row.reviewers.includes(ctx.userId)) {
      result.push({ level: 'edit', reason: reason('edit', 'form_reviewer') })
    }
    const units = new Set(ctx.principals.unitIds)
    if (
      row.users.includes(ctx.userId) ||
      row.responsible.includes(ctx.userId) ||
      row.units.some((id) => units.has(id))
    ) {
      result.push({ level: 'view', reason: reason('view', 'form_assignee') })
    }
    return result
  },

  visibleSql: (ctx) => {
    const conditions: SQL[] = [
      arrayContains(forms.assignedUsers, [ctx.userId]),
      arrayContains(forms.reviewers, [ctx.userId]),
      arrayContains(forms.responsibleUsers, [ctx.userId]),
    ]
    if (ctx.principals.unitIds.length > 0) {
      conditions.push(arrayOverlaps(forms.assignedUnits, ctx.principals.unitIds))
    }
    // EXISTS с корреляцией по идентификатору: поиск по первичному ключу форм,
    // а не подзапрос-список на каждый объект пространства
    return sql`EXISTS (SELECT 1 FROM ${forms}
      WHERE ${forms.id} = ${objects.id} AND (${sql.join(conditions, sql` OR `)}))`
  },
}
