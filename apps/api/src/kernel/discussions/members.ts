import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { db, type Executor } from '~/shared/db/client.js'
import { conversationMembers } from './schema.js'

/** Роль участника беседы: владелец группы или канала и остальные. */
export type MemberRole = 'owner' | 'member'

export interface MemberRow {
  userId: string
  role: string | null
  joinedAt: string
  lastReadMessageId: number | null
}

/** Личные настройки участника беседы: закрепление, «без звука», архив (ADR-0090, ADR-0161). */
export interface MemberSettingsPatch {
  pinned?: boolean
  muted?: boolean
  archived?: boolean
}

/**
 * Состав бесед (02-platform-kernel.md §6). Таблица участников — ядра: её пишут
 * только эти функции, а модуль чатов решает, кого и когда добавлять (ADR-0184).
 * Событий здесь нет — домен состава публикует вызывающий модуль.
 */
export const DiscussionMembers = {
  /** Добавить участников; уже состоящие не меняются. */
  async add(
    tx: Executor,
    conversationId: string,
    userIds: readonly string[],
    role: MemberRole = 'member',
  ): Promise<void> {
    if (userIds.length === 0) return
    await tx
      .insert(conversationMembers)
      .values(userIds.map((userId) => ({ conversationId, userId, role })))
      .onConflictDoNothing()
  },

  /** Убрать участника; истина — он состоял в беседе. */
  async remove(tx: Executor, conversationId: string, userId: string): Promise<boolean> {
    const deleted = await tx
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .returning({ userId: conversationMembers.userId })
    return deleted.length > 0
  },

  async ids(conversationId: string, executor: Executor = db()): Promise<string[]> {
    const rows = await executor
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
    return rows.map((row) => row.userId)
  },

  async list(conversationId: string, executor: Executor = db()): Promise<MemberRow[]> {
    return executor
      .select({
        userId: conversationMembers.userId,
        role: conversationMembers.role,
        joinedAt: conversationMembers.joinedAt,
        lastReadMessageId: conversationMembers.lastReadMessageId,
      })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
  },

  /** Участники, которым беседа не «без звука»: получатели уведомлений о сообщении. */
  async audience(conversationId: string, executor: Executor = db()): Promise<string[]> {
    const rows = await executor
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          or(
            isNull(conversationMembers.mutedUntil),
            lte(conversationMembers.mutedUntil, sql`now()`),
          ),
        ),
      )
    return rows.map((row) => row.userId)
  },

  /**
   * Личные настройки участника — не домен: без события. Убранная в архив беседа
   * перестаёт быть закреплённой; запись участника появляется, если её не было
   * (обсуждение объекта, где пользователь не состоит).
   */
  async setSettings(
    conversationId: string,
    userId: string,
    input: MemberSettingsPatch,
  ): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (input.pinned !== undefined) patch.pinned = input.pinned
    if (input.muted !== undefined)
      patch.mutedUntil = input.muted ? sql`'infinity'::timestamptz` : null
    if (input.archived !== undefined) {
      patch.archivedAt = input.archived ? sql`now()` : null
      if (input.archived) patch.pinned = false
    }
    if (Object.keys(patch).length === 0) return
    await db()
      .insert(conversationMembers)
      .values({ conversationId, userId, ...patch })
      .onConflictDoUpdate({
        target: [conversationMembers.conversationId, conversationMembers.userId],
        set: patch,
      })
  },
}
