import { type DocumentStatus, isDocumentClosed } from '@kchs/contracts'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { localDate } from '~/kernel/business-calendar/working-days.js'
import type { CalendarProjectionProvider } from '~/modules/calendar/public.js'
import { db } from '~/shared/db/client.js'
import { documents, objects } from '~/shared/db/schema/index.js'
import { isOverdue } from './document-service.js'
import { todayLocal } from './journal-service.js'

/**
 * Сроки документов на контроле в календаре (12-calendar-notifications-home.md
 * §1, ADR-0084): ответственному и контролёру документа — на весь день срока;
 * снятые с контроля при исполнении — отмечены выполненными. Поручения по
 * резолюциям показывает проекция задач.
 */
export const documentControlProjection: CalendarProjectionProvider = {
  key: 'documents.control',
  labelKey: 'calendar.projections.documentsControl',
  icon: 'document',
  list: async (ctx, range) => {
    const me = ctx.onBehalfOf ?? ctx.userId
    const from = localDate(range.from, range.timezone)
    const to = localDate(range.to, range.timezone)
    const rows = await db()
      .select({
        id: documents.id,
        title: objects.title,
        regNumber: documents.regNumber,
        deadline: documents.deadline,
        status: documents.status,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(
        and(
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'document'),
          inArray(documents.control, ['on', 'done']),
          or(eq(documents.responsibleId, me), eq(documents.controllerId, me)),
          sql`${documents.deadline} >= ${from}::date AND ${documents.deadline} < ${to}::date`,
        ),
      )
      .orderBy(documents.deadline)
      .limit(500)
    const today = todayLocal()
    return rows.flatMap((row) =>
      row.deadline
        ? [
            {
              objectId: row.id,
              objectType: 'document' as const,
              title: row.title,
              subtitle: row.regNumber,
              date: row.deadline,
              at: null,
              status: row.status,
              overdue: isOverdue({ deadline: row.deadline, status: row.status }, today),
              done: isDocumentClosed(row.status as DocumentStatus),
            },
          ]
        : [],
    )
  },
}
