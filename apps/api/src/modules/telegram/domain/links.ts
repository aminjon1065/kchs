import { createHash, randomBytes } from 'node:crypto'
import type { Locale } from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { telegramLinks } from '~/shared/db/schema/index.js'
import { redis } from '~/shared/redis/index.js'

/** Одноразовая ссылка привязки живёт 15 минут. */
const LINK_TTL_SECONDS = 15 * 60
/** Параметр `start` в Telegram: до 64 символов `A-Za-z0-9_-`. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

/** В Redis — хеш токена: дамп Redis не даёт действующих ссылок. */
const linkKey = (token: string) =>
  `kchs:telegram:link:${createHash('sha256').update(token).digest('hex')}`

interface PendingLink {
  userId: string
  locale: Locale
}

export interface TelegramLink {
  userId: string
  chatId: number
  username: string | null
  linkedAt: string
}

export type LinkResult =
  | { kind: 'linked'; userId: string; displayName: string; locale: Locale }
  /** Токен неизвестен, истёк, уже использован или пользователь заблокирован. */
  | { kind: 'invalid' }
  /** Чат уже привязан к другому пользователю. */
  | { kind: 'taken' }

/**
 * Привязка личного чата Telegram к пользователю (14-automation-integrations.md,
 * ADR-0061): профиль выдаёт одноразовую ссылку `t.me/<бот>?start=<токен>`,
 * бот получает `/start <токен>` и запоминает чат. Изменения — с событием и аудитом.
 */
export const TelegramLinks = {
  async get(userId: string): Promise<TelegramLink | null> {
    const [row] = await db()
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, userId))
      .limit(1)
    return row ?? null
  },

  async byChat(chatId: number): Promise<TelegramLink | null> {
    const [row] = await db()
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.chatId, chatId))
      .limit(1)
    return row ?? null
  },

  /** Чаты привязанных пользователей из списка. */
  async chats(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map()
    const rows = await db()
      .select({ userId: telegramLinks.userId, chatId: telegramLinks.chatId })
      .from(telegramLinks)
      .where(inArray(telegramLinks.userId, [...new Set(userIds)]))
    return new Map(rows.map((row) => [row.userId, row.chatId]))
  },

  /** Одноразовый токен привязки; прежние токены пользователя просто истекут. */
  async createToken(ctx: UserCtx): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(24).toString('base64url')
    const pending: PendingLink = { userId: ctx.userId, locale: ctx.locale }
    await redis().set(linkKey(token), JSON.stringify(pending), 'EX', LINK_TTL_SECONDS)
    return { token, expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString() }
  },

  /** `/start <токен>` из личного чата: токен погашается при первом предъявлении. */
  async complete(
    token: string,
    chat: { chatId: number; username: string | null },
  ): Promise<LinkResult> {
    if (!TOKEN_RE.test(token)) return { kind: 'invalid' }
    const raw = await redis().getdel(linkKey(token))
    if (!raw) return { kind: 'invalid' }
    const pending = JSON.parse(raw) as PendingLink

    const user = (await directory().refs([pending.userId])).get(pending.userId)
    if (!user || (user.status && user.status !== 'active')) return { kind: 'invalid' }

    const owner = await TelegramLinks.byChat(chat.chatId)
    if (owner && owner.userId !== pending.userId) return { kind: 'taken' }

    const ctx = systemCtx('telegram.link', { initiatorId: pending.userId, locale: pending.locale })
    try {
      await db().transaction(async (tx) => {
        await tx
          .insert(telegramLinks)
          .values({ userId: pending.userId, chatId: chat.chatId, username: chat.username })
          .onConflictDoUpdate({
            target: telegramLinks.userId,
            set: { chatId: chat.chatId, username: chat.username, linkedAt: sql`now()` },
          })
        await publishEvent(tx, ctx, {
          type: 'user.telegram_linked',
          object: { id: pending.userId, type: 'user', title: user.displayName },
          payload: { userId: pending.userId },
        })
        await audit(
          ctx,
          {
            action: 'integration.telegram_linked',
            objectId: pending.userId,
            objectType: 'user',
            details: { username: chat.username },
            severity: 'notice',
          },
          tx,
        )
      })
    } catch (error) {
      // Тот же чат одновременно привязывают к другому пользователю
      if (pgErrorCode(error) === UNIQUE_VIOLATION) return { kind: 'taken' }
      throw error
    }
    return {
      kind: 'linked',
      userId: pending.userId,
      displayName: user.displayName,
      locale: pending.locale,
    }
  },

  /**
   * Отвязать Telegram: сам пользователь (профиль или `/stop`) или бот
   * заблокирован. Возвращает чат, который был привязан.
   */
  async unlink(ctx: Ctx, userId: string, reason: 'user' | 'blocked'): Promise<number | null> {
    return db().transaction(async (tx) => {
      const [removed] = await tx
        .delete(telegramLinks)
        .where(eq(telegramLinks.userId, userId))
        .returning({ chatId: telegramLinks.chatId })
      if (!removed) return null
      await publishEvent(tx, ctx, {
        type: 'user.telegram_unlinked',
        object: { id: userId, type: 'user' },
        payload: { userId, reason },
      })
      await audit(
        ctx,
        {
          action: 'integration.telegram_unlinked',
          objectId: userId,
          objectType: 'user',
          details: { reason },
          severity: 'notice',
        },
        tx,
      )
      return removed.chatId
    })
  },
}
