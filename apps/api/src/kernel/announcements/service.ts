import type {
  AdminAnnouncement,
  Announcement,
  AnnouncementCreateInput,
  AnnouncementSeverity,
  AnnouncementStatus,
} from '@kchs/contracts'
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { actorId, type Ctx } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import { announcements } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { directory } from '../directory/port.js'
import { publishEvent } from '../events/publisher.js'

type Row = typeof announcements.$inferSelect

/** Важные объявления — выше: критичное не должно теряться под обычными. */
const SEVERITY_ORDER: Record<AnnouncementSeverity, number> = { critical: 0, warning: 1, info: 2 }

function statusOf(row: Row, now: Date): AnnouncementStatus {
  // Снятое до начала показа тоже снято, а не «запланировано»
  if (row.endsAt && new Date(row.endsAt) <= now) return 'ended'
  if (new Date(row.startsAt) > now) return 'scheduled'
  return 'active'
}

async function withAuthors(rows: Row[], database: Database): Promise<Announcement[]> {
  const authorIds = [...new Set(rows.map((row) => row.createdBy).filter((id) => id !== null))]
  const refs = await directory().refs(authorIds, database)
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity as AnnouncementSeverity,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdBy: row.createdBy ? (refs.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt,
  }))
}

/**
 * Объявления организации (15-admin-operations.md «Система», виджет «Объявления»
 * в «Мой день» — 12-calendar-notifications-home.md §4). Системная запись, а не
 * объект реестра: у объявления нет пространства и прав — его видят все
 * сотрудники в период показа. Публикация и снятие — события и аудит.
 */
export const AnnouncementService = {
  /** Показываемые сейчас: сначала важные, внутри — свежие. */
  async active(database: Database = db()): Promise<Announcement[]> {
    const rows = await database
      .select()
      .from(announcements)
      .where(
        and(
          lte(announcements.startsAt, sql`now()`),
          or(isNull(announcements.endsAt), gt(announcements.endsAt, sql`now()`)),
        ),
      )
      .orderBy(desc(announcements.startsAt))
      .limit(20)
    // Сортировка устойчива: внутри одной важности остаётся порядок по началу показа
    rows.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity as AnnouncementSeverity] -
        SEVERITY_ORDER[b.severity as AnnouncementSeverity],
    )
    return withAuthors(rows, database)
  },

  /** Все объявления для консоли — с состоянием на текущий момент. */
  async list(database: Database = db()): Promise<AdminAnnouncement[]> {
    const rows = await database
      .select()
      .from(announcements)
      .orderBy(desc(announcements.createdAt))
      .limit(200)
    const now = new Date()
    const items = await withAuthors(rows, database)
    return items.map((item, index) => ({ ...item, status: statusOf(rows[index] as Row, now) }))
  },

  async create(tx: Executor, ctx: Ctx, input: AnnouncementCreateInput): Promise<string> {
    const id = newId()
    await tx.insert(announcements).values({
      id,
      title: input.title,
      body: input.body,
      severity: input.severity,
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      endsAt: input.endsAt ?? null,
      createdBy: actorId(ctx),
    })
    await publishEvent(tx, ctx, {
      type: 'announcement.published',
      payload: { title: input.title },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.announcementPublished,
        details: { announcementId: id, title: input.title, severity: input.severity },
      },
      tx,
    )
    return id
  },

  /** Снять с показа: окончание — сейчас. Снятое повторно не меняется. */
  async withdraw(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const [row] = await tx
      .select()
      .from(announcements)
      .where(eq(announcements.id, id))
      .limit(1)
      .for('update')
    if (!row) throw errors.notFound('Объявление')
    if (statusOf(row, new Date()) === 'ended') return

    await tx.update(announcements).set({ endsAt: sql`now()` }).where(eq(announcements.id, id))
    await publishEvent(tx, ctx, {
      type: 'announcement.withdrawn',
      payload: { title: row.title },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.announcementWithdrawn,
        details: { announcementId: id, title: row.title },
      },
      tx,
    )
  },
}
